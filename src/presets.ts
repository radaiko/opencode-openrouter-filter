/**
 * Presets: named capability predicates a model must pass in addition to the
 * glob rules. Fields that a catalog source does not provide count as false,
 * so a preset only keeps models it can positively confirm.
 */

export type PresetName = "free-only" | "tool-calling" | "vision" | "reasoning" | "active";

export const PRESET_NAMES: readonly PresetName[] = [
  "free-only",
  "tool-calling",
  "vision",
  "reasoning",
  "active",
];

/** The shape of a catalog model this plugin reads. Keeps the core testable without the host SDK. */
export interface FilterableModel {
  readonly id: string;
  readonly status?: string;
  readonly cost?: { readonly input?: number; readonly output?: number };
  readonly capabilities?: {
    readonly toolcall?: boolean;
    readonly reasoning?: boolean;
    readonly input?: { readonly image?: boolean };
  };
}

function isFree(model: FilterableModel): boolean {
  if (model.id.endsWith(":free")) return true;
  const input = model.cost?.input;
  const output = model.cost?.output;
  return input === 0 && output === 0;
}

export const presets: Record<PresetName, (model: FilterableModel) => boolean> = {
  "free-only": isFree,
  "tool-calling": (model) => model.capabilities?.toolcall === true,
  vision: (model) => model.capabilities?.input?.image === true,
  reasoning: (model) => model.capabilities?.reasoning === true,
  active: (model) => model.status === "active",
};
