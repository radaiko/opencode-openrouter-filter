import { describe, expect, it } from "vitest";

import { applyToEditor, type CatalogEditor } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import type { DefaultModelRef } from "../src/filter.js";

interface FakeModel {
  id: string;
  providerID: string;
  cost?: { input?: number; output?: number };
}

/**
 * The host publishes the picker as `all.filter((m) => m.enabled)`, so hiding
 * means `update(..., (m) => (m.enabled = false))`, not `remove()`. The fake
 * records the disabled ids and applies the mutation so list() stays truthful.
 */
function fakeEditor(
  models: readonly FakeModel[],
  defaultRef?: DefaultModelRef,
): CatalogEditor & { disabled: Array<[string, string]> } {
  const state = models.map((m) => ({ ...m, enabled: true }));
  const disabled: Array<[string, string]> = [];
  return {
    disabled,
    list: () => state.map((m) => ({ ...m })),
    get: (providerID, modelID) => state.find((m) => m.providerID === providerID && m.id === modelID),
    update: (providerID, modelID, update) => {
      const hit = state.find((m) => m.providerID === providerID && m.id === modelID);
      if (hit) update(hit);
      disabled.push([providerID, modelID]);
    },
    default: { get: () => defaultRef },
  };
}

// @req REQ-MCF-05
describe("applyToEditor", () => {
  it("disables exactly the models the plan names, with their provider ids", () => {
    const editor = fakeEditor([
      { id: "a/free:free", providerID: "openrouter", cost: { input: 0, output: 0 } },
      { id: "a/paid", providerID: "openrouter", cost: { input: 1, output: 1 } },
      { id: "keepme", providerID: "litellm" },
    ]);
    const config = loadConfig({ rules: [{ provider: "openrouter", presets: ["free-only"] }] });
    const run = applyToEditor(config, editor);
    expect(editor.disabled).toEqual([["openrouter", "a/paid"]]);
    expect(run.removedCount).toBe(1);
  });

  it("does not disable the catalog default model", () => {
    const editor = fakeEditor(
      [
        { id: "a/free:free", providerID: "openrouter", cost: { input: 0, output: 0 } },
        { id: "a/paid", providerID: "openrouter", cost: { input: 1, output: 1 } },
        { id: "a/other", providerID: "openrouter", cost: { input: 1, output: 1 } },
      ],
      { providerID: "openrouter", modelID: "a/paid" },
    );
    const config = loadConfig({ rules: [{ provider: "openrouter", presets: ["free-only"] }] });
    applyToEditor(config, editor);
    expect(editor.disabled).toEqual([["openrouter", "a/other"]]);
  });

  it("is a no-op on an empty config", () => {
    const editor = fakeEditor([{ id: "x", providerID: "p" }]);
    const run = applyToEditor(loadConfig({}), editor);
    expect(editor.disabled).toEqual([]);
    expect(run.removedCount).toBe(0);
  });
});
