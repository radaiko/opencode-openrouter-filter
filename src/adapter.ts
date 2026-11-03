/**
 * Host bridge: turns a ModelEditor-like catalog draft into hidden models.
 *
 * Hiding is done with `enabled = false`, not `remove()`: the host computes the
 * model picker (`model.list` → `Model.available()`) as `all.filter(enabled)`,
 * while `remove()` only hides a model from later transforms and leaves it in
 * the published catalog. `enabled = false` is also what OpenCode's own
 * built-in plugins use to drop models from the picker.
 *
 * Catalog drafts key entries by `modelID`; `id` may be absent there, so the
 * bridge prefers `modelID` for both matching and for the editor calls.
 *
 * The editor is typed structurally so the whole decision path is testable
 * without the OpenCode host packages installed.
 */

import { applyFilter, type DefaultModelRef, type FilterRun, type ProviderCatalog } from "./filter.js";
import type { ValidatedConfig } from "./config.js";
import type { FilterableModel } from "./presets.js";

/** Catalog entry as the editor's `list()` hands it over. */
export interface CatalogEntry extends FilterableModel {
  readonly providerID?: string;
  /** Present on catalog drafts; `id` may be absent there. */
  readonly modelID?: string;
}

export interface CatalogEditor {
  list(providerID?: string): readonly CatalogEntry[];
  get(providerID: string, modelID: string): CatalogEntry | undefined;
  /** Mutate a catalog entry in place. The bridge sets `enabled = false`. */
  update(providerID: string, modelID: string, update: (model: { enabled?: boolean }) => void): void;
  readonly default: {
    get(): DefaultModelRef | undefined;
  };
}

/** The id a catalog entry is keyed and matched by. */
function entryId(model: CatalogEntry): string {
  return model.modelID ?? model.id;
}

/** Apply the validated config to the editor. Pure with respect to the config. */
export function applyToEditor(config: ValidatedConfig, editor: CatalogEditor): FilterRun {
  const listProviders = (): ProviderCatalog[] => {
    const grouped = new Map<string, FilterableModel[]>();
    for (const model of editor.list()) {
      const providerID = model.providerID ?? "unknown";
      const entry: FilterableModel = { ...model, id: entryId(model) };
      const models = grouped.get(providerID);
      if (models) models.push(entry);
      else grouped.set(providerID, [entry]);
    }
    return [...grouped].map(([providerID, models]) => ({ providerID, models }));
  };
  const run = applyFilter(config, {
    listProviders,
    getDefault: () => editor.default.get(),
  });
  for (const [providerID, modelIDs] of run.removals) {
    for (const modelID of modelIDs) {
      editor.update(providerID, modelID, (model) => {
        model.enabled = false;
      });
    }
  }
  return run;
}
