/**
 * Host bridge: turns a ModelEditor-like catalog draft into removals.
 *
 * The editor is typed structurally so the whole decision path is testable
 * without the OpenCode host packages installed.
 */

import { applyFilter, type DefaultModelRef, type FilterRun, type ProviderCatalog } from "./filter.js";
import type { ValidatedConfig } from "./config.js";
import type { FilterableModel } from "./presets.js";

export interface CatalogEditor {
  list(providerID?: string): readonly (FilterableModel & { readonly providerID?: string })[];
  get(providerID: string, modelID: string): FilterableModel | undefined;
  remove(providerID: string, modelID: string): void;
  readonly default: {
    get(): DefaultModelRef | undefined;
  };
}

/** Apply the validated config to the editor. Pure with respect to the config. */
export function applyToEditor(config: ValidatedConfig, editor: CatalogEditor): FilterRun {
  const listProviders = (): ProviderCatalog[] => {
    const grouped = new Map<string, FilterableModel[]>();
    for (const model of editor.list()) {
      const providerID = model.providerID ?? "unknown";
      const models = grouped.get(providerID);
      if (models) models.push(model);
      else grouped.set(providerID, [{ id: model.id }]);
    }
    return [...grouped].map(([providerID, models]) => ({ providerID, models }));
  };
  const run = applyFilter(config, {
    listProviders,
    getDefault: () => editor.default.get(),
  });
  for (const [providerID, modelIDs] of run.removals) {
    for (const modelID of modelIDs) editor.remove(providerID, modelID);
  }
  return run;
}
