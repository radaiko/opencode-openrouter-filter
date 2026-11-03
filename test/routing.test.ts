import { describe, expect, it } from "vitest";

import { applyFilter } from "../src/filter.js";
import { ConfigError } from "../src/config.js";
import {
  collectRoutingSettings,
  createRoutingState,
  createStatsClient,
  extractRoutingFromConfig,
  loadRoutingOptions,
  parseRoutingBlock,
  perfVerdict,
  priceVerdict,
  resolveSecretRef,
  stripJsonComments,
  type EndpointPerf,
} from "../src/routing.js";
import type { FilterableModel } from "../src/presets.js";
import type { ProviderCatalog } from "../src/filter.js";

// @req REQ-MCF-14
describe("parseRoutingBlock", () => {
  it("reads the OpenRouter wire spelling", () => {
    const parsed = parseRoutingBlock(
      {
        zdr: true,
        data_collection: "deny",
        sort: "price",
        max_price: { prompt: 0.5, completion: 2.5 },
        preferred_min_throughput: { p50: 60, p90: 30 },
        preferred_max_latency: { p50: 1.5, p90: 3 },
      },
      "test",
    );
    expect(parsed).toEqual({
      maxPrice: { prompt: 0.5, completion: 2.5 },
      minThroughput: { p50: 60, p90: 30 },
      maxLatency: { p50: 1.5, p90: 3 },
    });
  });

  it("accepts camelCase aliases and normalizes bare numbers to p50", () => {
    const parsed = parseRoutingBlock({ maxPrice: { prompt: 1 }, minThroughput: 40, maxLatency: 2 }, "test");
    expect(parsed).toEqual({
      maxPrice: { prompt: 1 },
      minThroughput: { p50: 40 },
      maxLatency: { p50: 2 },
    });
  });

  it("returns undefined when no honoured keys are present", () => {
    expect(parseRoutingBlock({ zdr: true, sort: "price" }, "test")).toBeUndefined();
    expect(parseRoutingBlock(undefined, "test")).toBeUndefined();
    expect(parseRoutingBlock("nope", "test")).toBeUndefined();
  });

  it("rejects malformed cutoffs", () => {
    expect(() => parseRoutingBlock({ max_price: "cheap" }, "test")).toThrow(ConfigError);
    expect(() => parseRoutingBlock({ preferred_max_latency: { p50: "fast" } }, "test")).toThrow(ConfigError);
    expect(() => parseRoutingBlock({ preferred_min_throughput: -5 }, "test")).toThrow(ConfigError);
  });
});

// @req REQ-MCF-14
describe("loadRoutingOptions", () => {
  it("applies defaults", () => {
    const options = loadRoutingOptions({ providers: { openrouter: { max_price: { prompt: 1 } } } });
    expect(options?.enabled).toBe(true);
    expect(options?.statsBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(options?.statsTtlMs).toBeGreaterThan(0);
    expect(options?.maxConcurrency).toBe(8);
  });

  it("trims trailing slashes from statsBaseUrl", () => {
    const options = loadRoutingOptions({ statsBaseUrl: "http://127.0.0.1:9999/api/v1///" });
    expect(options?.statsBaseUrl).toBe("http://127.0.0.1:9999/api/v1");
  });

  it("validates types", () => {
    expect(() => loadRoutingOptions("yes")).toThrow(ConfigError);
    expect(() => loadRoutingOptions({ enabled: "true" })).toThrow(ConfigError);
    expect(() => loadRoutingOptions({ statsTtlMs: 0 })).toThrow(ConfigError);
    expect(() => loadRoutingOptions({ maxConcurrency: -1 })).toThrow(ConfigError);
    expect(loadRoutingOptions(undefined)).toBeUndefined();
  });
});

// @req REQ-MCF-14
describe("config file reading", () => {
  it("tolerates comments and trailing commas but not comment text in strings", () => {
    const jsonc = `{
      // leading comment
      "a": "https://example.com//x", /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: "https://example.com//x", b: [1, 2] });
  });

  it("extracts providers.<id>.body.provider", () => {
    const text = JSON.stringify({
      plugins: ["something"],
      providers: {
        openrouter: { body: { provider: { max_price: { prompt: 0.5, completion: 2.5 }, sort: "price" } } },
        other: { options: { baseURL: "http://x" } },
      },
    });
    const parsed = extractRoutingFromConfig(text, "file");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.[0]).toBe("openrouter");
    expect(parsed.entries[0]?.[1]).toEqual({ maxPrice: { prompt: 0.5, completion: 2.5 } });
  });

  it("survives broken JSON and honours later files and explicit options", () => {
    expect(extractRoutingFromConfig("{not json", "file").entries).toEqual([]);
    const files: Record<string, string> = {
      "/root/opencode/opencode.json": JSON.stringify({
        providers: { openrouter: { body: { provider: { max_price: { prompt: 1, completion: 5 } } } } },
      }),
      "/project-dir/opencode.json": JSON.stringify({
        provider: { openrouter: { body: { provider: { max_price: { prompt: 0.2 } } } } },
      }),
    };
    const settings = collectRoutingSettings(
      {
        enabled: true,
        statsBaseUrl: "https://example.invalid",
        statsTtlMs: 1,
        maxConcurrency: 1,
        providers: { openrouter: { preferred_min_throughput: 100 } },
      },
      "/project-dir",
      {
        readFile: (path) => files[path],
        env: { XDG_CONFIG_HOME: "/root", HOME: "/root" },
      },
    );
    // project file overrode global prompt but not completion; options won for throughput
    expect(settings.get("openrouter")).toEqual({
      maxPrice: { prompt: 0.2, completion: 5 },
      minThroughput: { p50: 100 },
    });
  });

  it("reads only the configFile when given", () => {
    const settings = collectRoutingSettings(
      {
        enabled: true,
        statsBaseUrl: "https://example.invalid",
        statsTtlMs: 1,
        maxConcurrency: 1,
        configFile: "/explicit",
      },
      "/project-dir",
      { readFile: (path) => (path === "/explicit" ? JSON.stringify({ providers: { p: { body: { provider: { max_price: { prompt: 1 } } } } } }) : undefined) },
    );
    expect([...settings.keys()]).toEqual(["p"]);
  });
});

// @req REQ-MCF-15
describe("priceVerdict", () => {
  const paid: FilterableModel = { id: "x/y", cost: [{ input: 3, output: 15 }] };

  it("keeps models whose price fits and models without price data", () => {
    expect(priceVerdict(paid, { prompt: 0.5, completion: 2.5 })).toBeDefined();
    expect(priceVerdict({ id: "x/y", cost: [{ input: 0.3, output: 1.2 }] }, { prompt: 0.5, completion: 2.5 })).toBeUndefined();
    expect(priceVerdict({ id: "x/y" }, { prompt: 0.5 })).toBeUndefined();
  });

  it("keeps when any tier fits (catalog tiers are alternatives)", () => {
    const tiered: FilterableModel = {
      id: "x/y",
      cost: [
        { input: 5, output: 20 },
        { input: 0.3, output: 1 },
      ],
    };
    expect(priceVerdict(tiered, { prompt: 0.5, completion: 2.5 })).toBeUndefined();
  });

  it("checks each side independently", () => {
    expect(priceVerdict({ id: "x/y", cost: [{ input: 9, output: 0.1 }] }, { prompt: 0.5 })).toBeDefined();
    expect(priceVerdict({ id: "x/y", cost: [{ input: 9, output: 0.1 }] }, { completion: 2.5 })).toBeUndefined();
  });
});

// @req REQ-MCF-16
describe("perfVerdict", () => {
  const fast: EndpointPerf = { throughput: { p50: 120, p90: 80 }, latency: { p50: 900, p90: 1400 } };
  const slow: EndpointPerf = { throughput: { p50: 20, p90: 12 }, latency: { p50: 400, p90: 700 } };
  const settings = { minThroughput: { p50: 60, p90: 30 }, maxLatency: { p50: 1.5, p90: 3 } };

  it("keeps without stats or without cutoffs", () => {
    expect(perfVerdict(settings, undefined)).toBeUndefined();
    expect(perfVerdict(settings, [])).toBeUndefined();
    expect(perfVerdict({}, [slow])).toBeUndefined();
  });

  it("keeps when at least one endpoint meets every cutoff", () => {
    expect(perfVerdict(settings, [slow, fast])).toBeUndefined();
    expect(perfVerdict(settings, [slow])).toBeDefined();
  });

  it("treats missing measurements as passing", () => {
    expect(perfVerdict(settings, [{ throughput: null, latency: null }])).toBeUndefined();
    expect(perfVerdict(settings, [{ throughput: { p50: 10 }, latency: null }])).toBeDefined();
    expect(perfVerdict({ maxLatency: { p90: 3 } }, [{ throughput: { p50: 5 }, latency: null }])).toBeUndefined();
  });

  it("compares latency seconds against reported milliseconds", () => {
    expect(perfVerdict({ maxLatency: { p50: 1 } }, [{ throughput: null, latency: { p50: 1000 } }])).toBeUndefined();
    expect(perfVerdict({ maxLatency: { p50: 1 } }, [{ throughput: null, latency: { p50: 1001 } }])).toBeDefined();
  });
});

// @req REQ-MCF-16
describe("createStatsClient", () => {
  function fakeFetch(responses: Record<string, unknown | Error>) {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const canned = responses[url];
      if (canned instanceof Error) throw canned;
      if (canned === undefined) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(canned), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const base = "https://openrouter.invalid/api/v1";
  const okBody = {
    data: {
      endpoints: [
        { throughput_last_30m: { p50: 100 }, latency_last_30m: { p50: 500 } },
        { throughput_last_30m: null, latency_last_30m: null },
      ],
    },
  };

  it("fetches the endpoints path, stores percentiles and sends the key", async () => {
    const { fetchImpl, calls } = fakeFetch({ [`${base}/models/a-b/c-d/endpoints`]: okBody });
    let clock = 1000;
    const client = createStatsClient(
      { baseUrl: base, apiKey: "sk-test", ttlMs: 500, maxConcurrency: 2, fetchImpl },
      () => clock,
    );
    expect(client.needs("a-b/c-d")).toBe(true);
    const stored = await client.prefetch(["a-b/c-d"]);
    expect(stored).toBe(1);
    expect(calls[0]?.url).toBe(`${base}/models/a-b/c-d/endpoints`);
    expect(calls[0]?.headers?.authorization).toBe("Bearer sk-test");
    expect(client.get("a-b/c-d")).toEqual([
      { throughput: { p50: 100 }, latency: { p50: 500 } },
      { throughput: null, latency: null },
    ]);
    // Cached until TTL, then refetched.
    expect(client.needs("a-b/c-d")).toBe(false);
    clock += 600;
    expect(client.needs("a-b/c-d")).toBe(true);
  });

  it("encodes odd slug parts and fails soft to undefined", async () => {
    const { fetchImpl } = fakeFetch({ [`${base}/models/a/b%2Bc/endpoints`]: okBody });
    const client = createStatsClient({ baseUrl: base, ttlMs: 1000, maxConcurrency: 2, fetchImpl });
    await client.prefetch(["a/b+c", "no-slash", "a/"]);
    expect(client.get("a/b+c")).toBeDefined();
    expect(client.get("no-slash")).toBeUndefined();
    expect(client.get("a/")).toBeUndefined();
  });

  it("caches failures briefly and does not refetch within the failure window", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    let clock = 0;
    const client = createStatsClient({ baseUrl: base, ttlMs: 60_000, maxConcurrency: 1, fetchImpl }, () => clock);
    await client.prefetch(["x/y"]);
    expect(client.get("x/y")).toBeUndefined();
    await client.prefetch(["x/y"]);
    expect(calls).toHaveLength(1); // failure TTL is 30s and the clock never moved
    clock += 31_000;
    expect(client.needs("x/y")).toBe(true);
  });

  it("treats an empty endpoints array as no data", async () => {
    const { fetchImpl } = fakeFetch({ [`${base}/models/x/y/endpoints`]: { data: { endpoints: [] } } });
    const client = createStatsClient({ baseUrl: base, ttlMs: 1000, maxConcurrency: 1, fetchImpl });
    await client.prefetch(["x/y"]);
    expect(client.get("x/y")).toBeUndefined();
  });
});

// @req REQ-MCF-16
describe("createRoutingState", () => {
  function state(routingOptions: unknown, responses: Record<string, unknown>, env?: Record<string, string | undefined>) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const canned = responses[String(input)];
      return new Response(JSON.stringify(canned ?? {}), { status: canned === undefined ? 404 : 200 });
    }) as unknown as typeof fetch;
    return createRoutingState(routingOptions, "/project-dir", {
      readFile: () => undefined,
      env: env ?? {},
      fetchImpl,
    });
  }

  it("is inactive without routing options or matching settings", () => {
    expect(state(undefined, {})).toBeUndefined();
    expect(state({ enabled: false, providers: { p: { max_price: { prompt: 1 } } } }, {})).toBeUndefined();
    expect(state({}, {})).toBeUndefined();
  });

  it("hides on price immediately and defers perf models until refresh", async () => {
    const routing = state(
      {
        providers: {
          routed: {
            max_price: { prompt: 0.5, completion: 2.5 },
            preferred_min_throughput: { p50: 60 },
          },
        },
        statsBaseUrl: "https://stats.invalid/v1",
      },
      { "https://stats.invalid/v1/models/good/one/endpoints": { data: { endpoints: [{ throughput_last_30m: { p50: 100 } }] } } },
    );
    expect(routing).toBeDefined();
    const pricedOut = routing?.verdictFor("routed", { id: "expensive/one", cost: [{ input: 5, output: 5 }] });
    expect(pricedOut).toContain("max_price");
    // Stats not fetched yet: the slow-looking model is kept for now.
    expect(routing?.verdictFor("routed", { id: "good/one", cost: [{ input: 0.1, output: 0.5 }] })).toBeUndefined();
    expect(routing?.pendingCount()).toBe(1);
    // expensive/one busts the price gate, so no stats are requested for it.
    expect(routing?.pendingCount()).toBe(1);
    expect(await routing?.refresh()).toBe(true);
    expect(routing?.pendingCount()).toBe(0);
    // A model with bad stats hides once the data is in.
    expect(routing?.verdictFor("routed", { id: "good/one", cost: [{ input: 0.1, output: 0.5 }] })).toBeUndefined();
  });

  it("ignores providers without settings", () => {
    const routing = state({ providers: { routed: { max_price: { prompt: 1 } } } }, {});
    expect(routing?.verdictFor("other", { id: "x/y", cost: [{ input: 100, output: 100 }] })).toBeUndefined();
  });

  it("resolves {file:...} and {env:...} apiKey refs against deps", async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ data: { endpoints: [{ throughput_last_30m: { p50: 100 } }] } }));
    }) as unknown as typeof fetch;
    const routing = createRoutingState(
      {
        providers: { routed: { preferred_min_throughput: 50 } },
        statsBaseUrl: "https://stats.invalid/v1",
        apiKey: "{file:~/secrets/openrouter.key}",
      },
      "/project-dir",
      {
        readFile: (path) => (path === "/home/tester/secrets/openrouter.key" ? "sk-from-file\n" : undefined),
        env: { HOME: "/home/tester" },
        fetchImpl,
      },
    );
    expect(routing).toBeDefined();
    expect(routing?.verdictFor("routed", { id: "good/one" })).toBeUndefined();
    await routing?.refresh();
    expect(headers[0]?.authorization).toBe("Bearer sk-from-file");
  });

  it("falls back to OPENROUTER_API_KEY when a secret ref points nowhere", async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ data: { endpoints: [] } }));
    }) as unknown as typeof fetch;
    const routing = createRoutingState(
      {
        providers: { routed: { preferred_min_throughput: 50 } },
        statsBaseUrl: "https://stats.invalid/v1",
        apiKey: "{env:OPENROUTER_TOKEN}",
      },
      "/project-dir",
      { readFile: () => undefined, env: { OPENROUTER_TOKEN: "", OPENROUTER_API_KEY: "sk-ambient" }, fetchImpl },
    );
    expect(routing).toBeDefined();
    expect(routing?.verdictFor("routed", { id: "good/one" })).toBeUndefined();
    await routing?.refresh();
    expect(headers[0]?.authorization).toBe("Bearer sk-ambient");
  });
});

// @req REQ-MCF-16
describe("resolveSecretRef", () => {
  const files: Record<string, string> = { "/keys/or.key": " sk-file \n" };
  const readFile = (path: string) => files[path];

  it("passes literals through unchanged", () => {
    expect(resolveSecretRef("sk-or-v1-abc", readFile, {})).toBe("sk-or-v1-abc");
  });

  it("reads {file:...} refs, expanding ~ via HOME", () => {
    expect(resolveSecretRef("{file:/keys/or.key}", readFile, {})).toBe("sk-file");
    expect(resolveSecretRef("{file:~/or.key}", readFile, { HOME: "/keys" })).toBe("sk-file");
    expect(resolveSecretRef("{file:/keys/missing.key}", readFile, {})).toBeUndefined();
  });

  it("reads {env:...} refs and treats empty as missing", () => {
    expect(resolveSecretRef("{env:OR_KEY}", readFile, { OR_KEY: "sk-env" })).toBe("sk-env");
    expect(resolveSecretRef("{env:OR_KEY}", readFile, { OR_KEY: "" })).toBeUndefined();
    expect(resolveSecretRef("{env:not-an-identifier}", readFile, {})).toBeUndefined();
  });
});

// @req REQ-MCF-15
describe("applyFilter routing pass", () => {
  const config = { disabled: false, defaults: undefined, rules: [], warnings: [] };
  const models: FilterableModel[] = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ];
  const input = (
    overrides: Partial<{ routingFor: (provider: string, model: FilterableModel) => string | undefined; getDefault: () => { providerID: string; modelID: string } | undefined }> = {},
  ) => ({
    listProviders: (): ProviderCatalog[] => [{ providerID: "p", models }],
    getDefault: () => undefined,
    ...overrides,
  });

  it("hides models the routing verdict rejects", () => {
    const run = applyFilter(config, input({ routingFor: (_p, m) => (m.id === "b" ? "too slow" : undefined) }));
    expect(run.removals.get("p")).toEqual(["b"]);
    expect(run.removedCount).toBe(1);
  });

  it("never hides the catalog default and warns when little would remain", () => {
    const two: FilterableModel[] = [{ id: "a" }, { id: "b" }];
    const run = applyFilter(config, {
      listProviders: (): ProviderCatalog[] => [{ providerID: "p", models: two }],
      routingFor: (_p, m) => (m.id === "a" || m.id === "b" ? "nope" : undefined),
      getDefault: () => ({ providerID: "p", modelID: "a" }),
    });
    // b hidden, a protected as default -> only default remains, warned.
    expect(run.removals.get("p")).toEqual(["b"]);
    expect(run.warnings.some((w) => w.includes("only the default model"))).toBe(true);
  });

  it("skips the routing pass when it would empty a provider", () => {
    const run = applyFilter(config, input({ routingFor: () => "nothing meets cutoffs" }));
    expect(run.removals.size).toBe(0);
    expect(run.warnings.some((w) => w.includes("nothing was removed by routing"))).toBe(true);
  });

  it("combines with rule removals without double counting", () => {
    const configWithRule = {
      disabled: false,
      defaults: undefined,
      warnings: [],
      rules: [
        {
          provider: "p",
          include: [],
          exclude: ["b"],
          presets: [],
          allowEmpty: false,
          protectDefault: true,
        },
      ],
    };
    const run = applyFilter(configWithRule, input({ routingFor: (_p, m) => (m.id === "b" || m.id === "c" ? "slow" : undefined) }));
    expect(run.removals.get("p")).toEqual(["b", "c"]);
    expect(run.removedCount).toBe(2);
  });
});
