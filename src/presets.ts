/**
 * Presets: named capability predicates a model must pass in addition to the
 * glob rules. Fields that a catalog source does not provide count as false,
 * so a preset only keeps models it can positively confirm.
 *
 * The shapes mirror `Model.Info` from `@opencode/schema` (OpenCode V2):
 * `cost` is a list of per-million-token tier entries, `capabilities.tools`
 * is a boolean, and modalities live in `capabilities.input`/`.output` string
 * lists. Older/alternative shapes (a plain cost object, `toolcall`/`reasoning`
 * booleans, `input.image`) are still honoured so the core stays useful for
 * hand-written config providers.
 */

export type PresetName = "free-only" | "tool-calling" | "vision" | "reasoning" | "active";

export const PRESET_NAMES: readonly PresetName[] = [
  "free-only",
  "tool-calling",
  "vision",
  "reasoning",
  "active",
];

export interface CostEntry {
  readonly input?: number;
  readonly output?: number;
}

/** The shape of a catalog model this plugin reads. Keeps the core testable without the host SDK. */
export interface FilterableModel {
  readonly id: string;
  /** Already-hidden catalog entries stay hidden; the bridge never re-enables. */
  readonly enabled?: boolean;
  readonly status?: string;
  readonly cost?: CostEntry | readonly CostEntry[];
  readonly capabilities?: {
    /** V2 `Model.Info`: boolean tool support. */
    readonly tools?: boolean;
    /** Legacy/config-provider spelling. */
    readonly toolcall?: boolean;
    /** V2: reasoning appears in `output`; some sources set a boolean instead. */
    readonly reasoning?: boolean;
    readonly input?: readonly string[] | { readonly image?: boolean };
    readonly output?: readonly string[];
  };
}

function costEntries(cost: FilterableModel["cost"]): readonly CostEntry[] | undefined {
  if (cost === undefined) return undefined;
  if (Array.isArray(cost)) return cost as readonly CostEntry[];
  return [cost as CostEntry];
}

function isFree(model: FilterableModel): boolean {
  if (model.id.endsWith(":free")) return true;
  const entries = costEntries(model.cost);
  if (entries === undefined || entries.length === 0) return false;
  return entries.every((entry) => entry.input === 0 && entry.output === 0);
}

function hasToolCalling(model: FilterableModel): boolean {
  return model.capabilities?.tools === true || model.capabilities?.toolcall === true;
}

function hasVision(model: FilterableModel): boolean {
  const input = model.capabilities?.input;
  if (input === undefined) return false;
  if (Array.isArray(input)) return (input as readonly string[]).includes("image");
  return (input as { readonly image?: boolean }).image === true;
}

function hasReasoning(model: FilterableModel): boolean {
  if (model.capabilities?.reasoning === true) return true;
  const output = model.capabilities?.output;
  return Array.isArray(output) && output.includes("reasoning");
}

function isActive(model: FilterableModel): boolean {
  return model.status === "active";
}

export const presets: Record<PresetName, (model: FilterableModel) => boolean> = {
  "free-only": isFree,
  "tool-calling": hasToolCalling,
  vision: hasVision,
  reasoning: hasReasoning,
  active: isActive,
};
