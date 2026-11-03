/**
 * Routing filter: mirrors the OpenRouter provider-routing settings that live
 * in the user's own OpenCode config (`providers.<id>.body.provider`) and
 * hides catalog models that could never satisfy them.
 *
 * Settings honoured (per provider):
 * - `max_price: {prompt, completion}` — USD per million tokens, the same
 *   unit the catalog `cost` tiers use. Hard gate, like OpenRouter's.
 * - `preferred_min_throughput` — tokens/sec; a bare number applies to p50.
 * - `preferred_max_latency` — seconds; a bare number applies to p50.
 *
 * Throughput/latency percentiles are not in the catalog; they come from the
 * OpenRouter endpoints API (`GET /models/{author}/{slug}/endpoints`, fields
 * `throughput_last_30m` in tokens/sec and `latency_last_30m` in **ms**).
 * That API returns null stats without an API key, so fetching is best-effort
 * and asynchronous: models stay visible until stats say otherwise.
 * A model is kept when at least one endpoint meets every specified cutoff
 * (missing measurements count as passing), matching OpenRouter's own
 * "preferred, never excluded" semantics as closely as a hard picker can.
 */

import { existsSync, readFileSync } from "node:fs";

import { ConfigError } from "./config.js";
import { costEntries, type FilterableModel } from "./presets.js";

export const PERCENTILE_KEYS = ["p50", "p75", "p90", "p99"] as const;
export type PercentileKey = (typeof PERCENTILE_KEYS)[number];
export type PercentileCutoffs = Partial<Record<PercentileKey, number>>;

export interface MaxPrice {
  readonly prompt?: number;
  readonly completion?: number;
}

/** The routing cutoffs we honour from `body.provider`. */
export interface RoutingSettings {
  readonly maxPrice?: MaxPrice;
  readonly minThroughput?: PercentileCutoffs;
  readonly maxLatency?: PercentileCutoffs;
}

/** One endpoint's measured percentiles; null when the API reported none. */
export interface EndpointPerf {
  readonly throughput: PercentileCutoffs | null;
  readonly latency: PercentileCutoffs | null;
}

/** Plugin options under `routing`, after validation. */
export interface ValidatedRouting {
  readonly enabled: boolean;
  readonly providers?: Record<string, unknown>;
  readonly configFile?: string;
  readonly statsBaseUrl: string;
  readonly apiKey?: string;
  readonly statsTtlMs: number;
  readonly maxConcurrency: number;
}

const DEFAULT_STATS_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_STATS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 8;
const FAILURE_TTL_MS = 30 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${where} must be a positive number`);
  }
  return value;
}

function definedCutoffs(value: PercentileCutoffs | undefined): boolean {
  return value !== undefined && PERCENTILE_KEYS.some((k) => value[k] !== undefined);
}

function asCutoffs(value: unknown, where: string): PercentileCutoffs | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(`${where} must be a non-negative number`);
    }
    return { p50: value };
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${where} must be a number or an object with p50/p75/p90/p99`);
  }
  const out: Record<string, number> = {};
  let any = false;
  for (const key of PERCENTILE_KEYS) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ConfigError(`${where}.${key} must be a non-negative number`);
    }
    out[key] = v;
    any = true;
  }
  return any ? (out as PercentileCutoffs) : undefined;
}

function asMaxPrice(value: unknown, where: string): MaxPrice | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ConfigError(`${where} must be an object with prompt/completion in USD per million tokens`);
  }
  const out: Record<string, number> = {};
  let any = false;
  for (const key of ["prompt", "completion"] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ConfigError(`${where}.${key} must be a non-negative number (USD per million tokens)`);
    }
    out[key] = v;
    any = true;
  }
  return any ? (out as MaxPrice) : undefined;
}

function firstDefined(...values: readonly unknown[]): unknown {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/**
 * Parse one `body.provider` block. Accepts the OpenRouter wire spelling
 * (`max_price`, `preferred_min_throughput`, `preferred_max_latency`) and
 * camelCase aliases; unrelated keys (zdr, data_collection, sort, ...) are
 * ignored — they are per-request choices with no model-level equivalent.
 */
export function parseRoutingBlock(raw: unknown, where: string): RoutingSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const maxPrice = asMaxPrice(firstDefined(raw.max_price, raw.maxPrice), `${where}.max_price`);
  const minThroughput = asCutoffs(
    firstDefined(raw.preferred_min_throughput, raw.preferredMinThroughput, raw.minThroughput),
    `${where}.preferred_min_throughput`,
  );
  const maxLatency = asCutoffs(
    firstDefined(raw.preferred_max_latency, raw.preferredMaxLatency, raw.maxLatency),
    `${where}.preferred_max_latency`,
  );
  if (!maxPrice && !definedCutoffs(minThroughput) && !definedCutoffs(maxLatency)) return undefined;
  return {
    ...(maxPrice ? { maxPrice } : {}),
    ...(minThroughput ? { minThroughput } : {}),
    ...(maxLatency ? { maxLatency } : {}),
  };
}

/** Validate the plugin's `routing` option block. */
export function loadRoutingOptions(raw: unknown): ValidatedRouting | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ConfigError("routing must be an object");
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw new ConfigError("routing.enabled must be a boolean");
  if (raw.providers !== undefined && !isRecord(raw.providers)) {
    throw new ConfigError("routing.providers must be an object keyed by provider id");
  }
  if (raw.configFile !== undefined && typeof raw.configFile !== "string") {
    throw new ConfigError("routing.configFile must be a path string");
  }
  let statsBaseUrl = DEFAULT_STATS_BASE_URL;
  if (raw.statsBaseUrl !== undefined) {
    if (typeof raw.statsBaseUrl !== "string" || raw.statsBaseUrl.trim() === "") {
      throw new ConfigError("routing.statsBaseUrl must be a non-empty URL string");
    }
    statsBaseUrl = raw.statsBaseUrl.trim().replace(/\/+$/, "");
  }
  if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") {
    throw new ConfigError("routing.apiKey must be a string");
  }
  const statsTtlMs =
    raw.statsTtlMs === undefined ? DEFAULT_STATS_TTL_MS : positiveNumber(raw.statsTtlMs, "routing.statsTtlMs");
  const maxConcurrency =
    raw.maxConcurrency === undefined
      ? DEFAULT_MAX_CONCURRENCY
      : positiveNumber(raw.maxConcurrency, "routing.maxConcurrency");
  return {
    enabled,
    ...(raw.providers !== undefined ? { providers: raw.providers as Record<string, unknown> } : {}),
    ...(raw.configFile !== undefined ? { configFile: raw.configFile as string } : {}),
    statsBaseUrl,
    ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey as string } : {}),
    statsTtlMs,
    maxConcurrency,
  };
}

/**
 * JSONC without comments: tolerate comments and trailing commas so pasted
 * OpenCode config content parses. Strings are tracked so comment-like text
 * inside them survives.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i += 1;
      while (i < n) {
        const s = text[i];
        out += s;
        i += 1;
        if (s === "\\") {
          if (i < n) {
            out += text[i];
            i += 1;
          }
        } else if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Global → $OPENCODE_CONFIG → project; later entries override earlier ones. */
export function discoverConfigFiles(
  directory: string,
  env: Record<string, string | undefined> = process.env,
  homedir: string = require_homedir(),
): string[] {
  const configHome = env.XDG_CONFIG_HOME || `${homedir}/.config`;
  const files = [
    `${configHome}/opencode/opencode.json`,
    `${configHome}/opencode/opencode.jsonc`,
  ];
  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
  files.push(`${directory}/opencode.json`, `${directory}/opencode.jsonc`);
  return files;
}

// Indirect so unit tests never touch os.homedir().
function require_homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

interface ParsedConfigFile {
  /** provider id -> routing cutoffs found in this file, in file order. */
  readonly entries: ReadonlyArray<readonly [string, RoutingSettings]>;
}

/** Extract routing blocks from one OpenCode config file's JSON text. */
export function extractRoutingFromConfig(text: string, where: string): ParsedConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return { entries: [] };
  }
  if (!isRecord(parsed)) return { entries: [] };
  const entries: Array<[string, RoutingSettings]> = [];
  // V2 uses `providers`; `provider` is honoured for older layouts.
  for (const block of [parsed.providers, parsed.provider]) {
    if (!isRecord(block)) continue;
    for (const [providerID, entry] of Object.entries(block)) {
      if (!isRecord(entry)) continue;
      const body = entry.body;
      const block_ = isRecord(body) ? body.provider : undefined;
      const settings = parseRoutingBlock(block_, `${where}: providers.${providerID}`);
      if (settings) entries.push([providerID, settings]);
    }
  }
  return { entries };
}

function mergeMaxPrice(base: MaxPrice | undefined, over: MaxPrice | undefined): MaxPrice | undefined {
  if (!base) return over;
  if (!over) return base;
  const prompt = over.prompt ?? base.prompt;
  const completion = over.completion ?? base.completion;
  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(completion !== undefined ? { completion } : {}),
  };
}

function mergeSettings(base: RoutingSettings | undefined, over: RoutingSettings): RoutingSettings {
  if (!base) return over;
  const maxPrice = mergeMaxPrice(base.maxPrice, over.maxPrice);
  const minThroughput = over.minThroughput ?? base.minThroughput;
  const maxLatency = over.maxLatency ?? base.maxLatency;
  return {
    ...(maxPrice ? { maxPrice } : {}),
    ...(minThroughput ? { minThroughput } : {}),
    ...(maxLatency ? { maxLatency } : {}),
  };
}

export interface RoutingDeps {
  readFile?: (path: string) => string | undefined;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Per-provider cutoffs: config files in ascending priority, then the plugin's
 * own `routing.providers` options on top.
 */
export function collectRoutingSettings(
  routing: ValidatedRouting,
  directory: string,
  deps: RoutingDeps = {},
): Map<string, RoutingSettings> {
  const readFile =
    deps.readFile ??
    ((path: string): string | undefined => {
      try {
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      } catch {
        return undefined;
      }
    });
  const files = routing.configFile
    ? [routing.configFile]
    : discoverConfigFiles(directory, deps.env ?? process.env);
  const map = new Map<string, RoutingSettings>();
  for (const file of files) {
    const text = readFile(file);
    if (text === undefined) continue;
    for (const [providerID, settings] of extractRoutingFromConfig(text, file).entries) {
      map.set(providerID, mergeSettings(map.get(providerID), settings));
    }
  }
  if (routing.providers) {
    for (const [providerID, raw] of Object.entries(routing.providers)) {
      const settings = parseRoutingBlock(raw, `routing.providers.${providerID}`);
      if (settings) map.set(providerID, mergeSettings(map.get(providerID), settings));
    }
  }
  return map;
}

interface CacheEntry {
  readonly at: number;
  readonly value: EndpointPerf[] | undefined;
  readonly ttlMs: number;
}

export interface StatsClient {
  /** Cached percentiles; undefined when unavailable or not yet fetched. */
  get(modelID: string): EndpointPerf[] | undefined;
  /** True when no (fresh) stats are cached for this model. */
  needs(modelID: string): boolean;
  /** Fetch everything still needed; returns how many got real stats. */
  prefetch(modelIDs: Iterable<string>): Promise<number>;
}

function cleanPercentiles(value: unknown): PercentileCutoffs | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  let any = false;
  for (const key of PERCENTILE_KEYS) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
      any = true;
    }
  }
  return any ? (out as PercentileCutoffs) : null;
}

/**
 * OpenRouter `GET /models/{author}/{slug}/endpoints` with a small in-memory
 * cache and bounded concurrency. Failures cache as "no data" briefly, so a
 * flaky API never spams requests or hides models.
 */
export function createStatsClient(
  options: {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly ttlMs: number;
    readonly maxConcurrency: number;
    readonly fetchImpl?: typeof fetch;
  },
  now: () => number = Date.now,
): StatsClient {
  const cache = new Map<string, CacheEntry>();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function load(modelID: string): Promise<EndpointPerf[] | undefined> {
    const slash = modelID.indexOf("/");
    if (slash <= 0 || slash === modelID.length - 1) return undefined;
    const author = modelID.slice(0, slash);
    const slug = modelID.slice(slash + 1);
    const url = `${options.baseUrl}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await fetchImpl(url, { headers });
      if (!response.ok) return undefined;
      const body = (await response.json()) as unknown;
      const endpoints = isRecord(body) && isRecord(body.data) ? body.data.endpoints : undefined;
      if (!Array.isArray(endpoints) || endpoints.length === 0) return undefined;
      const perf: EndpointPerf[] = [];
      for (const endpoint of endpoints) {
        if (!isRecord(endpoint)) continue;
        perf.push({
          throughput: cleanPercentiles(endpoint.throughput_last_30m),
          latency: cleanPercentiles(endpoint.latency_last_30m),
        });
      }
      return perf.length > 0 ? perf : undefined;
    } catch {
      return undefined;
    }
  }

  function fresh(modelID: string): boolean {
    const hit = cache.get(modelID);
    return hit !== undefined && now() - hit.at < hit.ttlMs;
  }

  return {
    get: (modelID) => (fresh(modelID) ? cache.get(modelID)?.value : undefined),
    needs: (modelID) => !fresh(modelID),
    async prefetch(modelIDs) {
      const queue = [...new Set(modelIDs)].filter((id) => !fresh(id));
      let stored = 0;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          const modelID = queue[cursor++];
          if (modelID === undefined) continue;
          const value = await load(modelID);
          cache.set(modelID, {
            at: now(),
            value,
            ttlMs: value === undefined ? Math.min(options.ttlMs, FAILURE_TTL_MS) : options.ttlMs,
          });
          if (value !== undefined) stored += 1;
        }
      };
      const workers = Array.from({ length: Math.max(1, options.maxConcurrency) }, worker);
      await Promise.all(workers);
      return stored;
    },
  };
}

/** Reason text when the price tiers all bust the cutoffs; undefined = keep. */
export function priceVerdict(model: FilterableModel, maxPrice?: MaxPrice): string | undefined {
  if (!maxPrice || (maxPrice.prompt === undefined && maxPrice.completion === undefined)) return undefined;
  const tiers = costEntries(model.cost);
  if (tiers === undefined || tiers.length === 0) return undefined; // no price data -> keep
  const fits = tiers.some(
    (tier) =>
      (maxPrice.prompt === undefined || (tier.input ?? 0) <= maxPrice.prompt) &&
      (maxPrice.completion === undefined || (tier.output ?? 0) <= maxPrice.completion),
  );
  if (fits) return undefined;
  const parts: string[] = [];
  if (maxPrice.prompt !== undefined) parts.push(`prompt <= $${maxPrice.prompt}/M`);
  if (maxPrice.completion !== undefined) parts.push(`completion <= $${maxPrice.completion}/M`);
  return `max_price exceeded (${parts.join(", ")})`;
}

function endpointMeets(
  endpoint: EndpointPerf,
  minThroughput?: PercentileCutoffs,
  maxLatency?: PercentileCutoffs,
): boolean {
  if (minThroughput) {
    for (const key of PERCENTILE_KEYS) {
      const cutoff = minThroughput[key];
      if (cutoff === undefined) continue;
      const measured = endpoint.throughput?.[key];
      if (measured !== undefined && measured !== null && measured < cutoff) return false;
    }
  }
  if (maxLatency) {
    for (const key of PERCENTILE_KEYS) {
      const cutoff = maxLatency[key];
      if (cutoff === undefined) continue;
      const measured = endpoint.latency?.[key];
      // Cutoffs are seconds (OpenRouter request semantics); the API reports ms.
      if (measured !== undefined && measured !== null && measured > cutoff * 1000) return false;
    }
  }
  return true;
}

/** Reason text when no endpoint meets the cutoffs; undefined = keep. */
export function perfVerdict(settings: RoutingSettings, endpoints: EndpointPerf[] | undefined): string | undefined {
  const needsStats = definedCutoffs(settings.minThroughput) || definedCutoffs(settings.maxLatency);
  if (!needsStats) return undefined;
  if (endpoints === undefined || endpoints.length === 0) return undefined; // no stats -> keep
  const fits = endpoints.some((endpoint) => endpointMeets(endpoint, settings.minThroughput, settings.maxLatency));
  return fits ? undefined : "no endpoint meets the throughput/latency cutoffs";
}

export interface RoutingState {
  readonly active: boolean;
  /** Number of providers with routing cutoffs. */
  readonly providerCount: number;
  /** Reason the model is hidden by routing; undefined = keep. */
  verdictFor(providerID: string, model: FilterableModel): string | undefined;
  /** Models whose endpoint stats still need fetching. */
  pendingCount(): number;
  /** Fetch pending stats; true when at least one model gained data. */
  refresh(): Promise<boolean>;
}

/**
 * Wires cutoffs + stats client into the transform loop. Pending stats are
 * collected during transforms; `refresh()` (called between transforms) fetches
 * them and a catalog reload re-runs the filter with the results.
 */
export function createRoutingState(
  rawRouting: unknown,
  directory: string,
  deps: RoutingDeps = {},
): RoutingState | undefined {
  const routing = loadRoutingOptions(rawRouting);
  if (!routing || !routing.enabled) return undefined;
  const settingsByProvider = collectRoutingSettings(routing, directory, deps);
  if (settingsByProvider.size === 0) return undefined;
  const apiKey = routing.apiKey ?? deps.env?.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const stats = createStatsClient({
    baseUrl: routing.statsBaseUrl,
    ...(apiKey ? { apiKey } : {}),
    ttlMs: routing.statsTtlMs,
    maxConcurrency: routing.maxConcurrency,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const pending = new Set<string>();
  return {
    active: true,
    providerCount: settingsByProvider.size,
    verdictFor: (providerID, model) => {
      const settings = settingsByProvider.get(providerID);
      if (!settings) return undefined;
      const price = priceVerdict(model, settings.maxPrice);
      if (price) return price;
      const needsStats = definedCutoffs(settings.minThroughput) || definedCutoffs(settings.maxLatency);
      if (!needsStats) return undefined;
      if (stats.needs(model.id)) pending.add(model.id);
      return perfVerdict(settings, stats.get(model.id));
    },
    pendingCount: () => {
      let count = 0;
      for (const id of pending) if (stats.needs(id)) count += 1;
      return count;
    },
    async refresh() {
      const batch = [...pending];
      if (batch.length === 0) return false;
      const stored = await stats.prefetch(batch);
      for (const id of batch) pending.delete(id);
      return stored > 0;
    },
  };
}
