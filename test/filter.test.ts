import { describe, expect, it } from "vitest";

import { applyFilter, type ApplyInput, type ProviderCatalog } from "../src/filter.js";
import { loadConfig, type ValidatedConfig, type ValidatedRule } from "../src/config.js";
import type { FilterableModel } from "../src/presets.js";

function model(
  id: string,
  extra: Partial<Pick<FilterableModel, "status" | "cost" | "capabilities">> = {},
): FilterableModel {
  return { id, ...extra };
}

function input(
  providers: readonly ProviderCatalog[],
  defaultRef?: { providerID: string; modelID: string },
): ApplyInput {
  return {
    listProviders: () => providers,
    getDefault: () => defaultRef,
  };
}

function config(partial: Partial<ValidatedConfig>): ValidatedConfig {
  return { disabled: false, defaults: undefined, rules: [], warnings: [], ...partial };
}

function rule(partial: Partial<ValidatedRule> & { provider: string }): ValidatedRule {
  return {
    include: [],
    exclude: [],
    presets: [],
    allowEmpty: false,
    protectDefault: true,
    ...partial,
  };
}

const openrouter: ProviderCatalog = {
  providerID: "openrouter",
  models: [
    model("anthropic/claude-sonnet-4.5"),
    model("deepseek/deepseek-v4-flash:free", { cost: { input: 0, output: 0 } }),
    model("google/gemini-flash-latest"),
    model("z-ai/glm-5.3-flash", { cost: { input: 0, output: 0 } }),
  ],
};

const litellm: ProviderCatalog = {
  providerID: "litellm",
  models: [model("local/qwen3.8-flash-next"), model("local/deepseek-v4-pro")],
};

// @req REQ-MCF-02
describe("applyFilter include/exclude", () => {
  it("keeps only include matches", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "openrouter", include: ["*:free"] })] }),
      input([openrouter]),
    );
    expect(run.removals.get("openrouter")).toEqual([
      "anthropic/claude-sonnet-4.5",
      "google/gemini-flash-latest",
      "z-ai/glm-5.3-flash",
    ]);
    expect(run.warnings).toEqual([]);
  });

  // @req REQ-MCF-03
  it("exclude wins over include", () => {
    const run = applyFilter(
      config({
        rules: [
          rule({
            provider: "openrouter",
            include: ["z-ai/*", "anthropic/claude-sonnet-4.5"],
            exclude: ["*flash*"],
          }),
        ],
      }),
      input([openrouter]),
    );
    // z-ai matches include but is excluded; the anthropic model survives.
    expect(run.removals.get("openrouter")).toContain("z-ai/glm-5.3-flash");
    expect(run.removals.get("openrouter")).not.toContain("anthropic/claude-sonnet-4.5");
  });

  it("leaves unmatched providers untouched", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "openrouter", include: ["*:free"] })] }),
      input([openrouter, litellm]),
    );
    expect(run.removals.has("litellm")).toBe(false);
    expect(run.removedCount).toBe(3);
  });
});

// @req REQ-MCF-06
describe("applyFilter provider scoping", () => {
  it("supports glob provider patterns", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "litellm", include: ["local/qwen*"] })] }),
      input([openrouter, litellm]),
    );
    expect(run.removals.get("litellm")).toEqual(["local/deepseek-v4-pro"]);
    expect(run.removals.has("openrouter")).toBe(false);
  });

  it("warns when a provider pattern matches no provider and removes nothing", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "nope", include: ["*:free"] })] }),
      input([openrouter]),
    );
    expect(run.removals.size).toBe(0);
    expect(run.warnings.join(" ")).toContain('provider pattern "nope"');
  });
});

// @req REQ-MCF-04
describe("applyFilter presets", () => {
  it("ANDs several presets", () => {
    const run = applyFilter(
      config({
        rules: [
          rule({
            provider: "openrouter",
            presets: ["free-only", "tool-calling"],
          }),
        ],
      }),
      input([
        {
          providerID: "openrouter",
          models: [
            model("a/free-tc", { capabilities: { toolcall: true }, cost: { input: 0, output: 0 } }),
            model("a/free-notc", { cost: { input: 0, output: 0 } }),
            model("a/paid-tc", { capabilities: { toolcall: true }, cost: { input: 1, output: 1 } }),
          ],
        },
      ]),
    );
    expect(run.removals.get("openrouter")).toEqual(["a/free-notc", "a/paid-tc"]);
  });
});

// @req REQ-MCF-07
describe("applyFilter default-model protection", () => {
  it("keeps the catalog default model even when it fails the rule", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "openrouter", include: ["*:free"] })] }),
      input([openrouter], { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5" }),
    );
    expect(run.removals.get("openrouter")).not.toContain("anthropic/claude-sonnet-4.5");
  });

  it("removes the default model when protectDefault is false", () => {
    const run = applyFilter(
      config({
        rules: [rule({ provider: "openrouter", include: ["*:free"], protectDefault: false })],
      }),
      input([openrouter], { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5" }),
    );
    expect(run.removals.get("openrouter")).toContain("anthropic/claude-sonnet-4.5");
  });
});

// @req REQ-MCF-08
describe("applyFilter empty-catalog protection", () => {
  it("skips a rule that would remove every model and warns", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "openrouter", include: ["nope/*"] })] }),
      input([openrouter]),
    );
    expect(run.removals.has("openrouter")).toBe(false);
    expect(run.warnings.join(" ")).toContain("would remove all 4 models");
  });

  it("allows an empty result when allowEmpty is set", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "openrouter", include: ["nope/*"], allowEmpty: true })] }),
      input([openrouter]),
    );
    expect(run.removals.get("openrouter")).toHaveLength(4);
  });

  it("empty-catalog protection counts the protected default as kept", () => {
    const run = applyFilter(
      config({ rules: [rule({ provider: "litellm", include: ["local/deepseek*"] })] }),
      input([litellm], { providerID: "litellm", modelID: "local/qwen3.8-flash-next" }),
    );
    // deepseek is the only include match; qwen fails the rule but is the protected
    // default, so the provider ends up with both models and the veto must not fire.
    expect(run.warnings.join(" ")).not.toContain("would remove all");
    expect(run.removals.get("litellm") ?? []).not.toContain("local/qwen3.8-flash-next");
  });
});

// @req REQ-MCF-10
describe("applyFilter no-op warnings", () => {
  it("warns about an include pattern that matches no model", () => {
    const run = applyFilter(
      config({
        rules: [rule({ provider: "openrouter", include: ["*:free", "typo/*"], allowEmpty: true })],
      }),
      input([openrouter]),
    );
    expect(run.warnings.join(" ")).toContain('include pattern "typo/*"');
  });
});

// @req REQ-MCF-11
describe("applyFilter defaults merge", () => {
  it("merges defaults patterns into a matched rule", () => {
    const run = applyFilter(
      config({
        defaults: rule({ provider: "*", exclude: ["google/*"] }),
        rules: [rule({ provider: "openrouter", include: ["*:free"] })],
      }),
      input([openrouter, litellm]),
    );
    // openrouter: only :free survives (include), google gone anyway (defaults exclude)
    expect([...(run.removals.get("openrouter") ?? [])].sort()).toEqual(
      ["anthropic/claude-sonnet-4.5", "google/gemini-flash-latest", "z-ai/glm-5.3-flash"].sort(),
    );
    // litellm matched by the defaults glob alone: google rule excludes nothing here,
    // so it keeps everything.
    expect(run.removals.has("litellm")).toBe(false);
  });

  it("applies defaults to every provider when no rule matches", () => {
    const run = applyFilter(
      config({ defaults: rule({ provider: "*", presets: ["active"] }) }),
      input([openrouter]),
    );
    // no model has status active -> every model would go -> veto
    expect(run.warnings.join(" ")).toContain("would remove all 4 models");
  });
});

// @req REQ-MCF-12
describe("applyFilter disabled", () => {
  it("removes nothing when disabled", () => {
    const run = applyFilter(
      config({
        disabled: true,
        rules: [rule({ provider: "openrouter", include: ["*:free"] })],
      }),
      input([openrouter]),
    );
    expect(run.removals.size).toBe(0);
    expect(run.warnings).toEqual([]);
  });
});

// @req REQ-MCF-09
describe("applyFilter through the real loader", () => {
  it("end to end: free-only OpenRouter picker", () => {
    const config = loadConfig({
      rules: [{ provider: "openrouter", presets: ["free-only"] }],
    });
    const run = applyFilter(config, input([openrouter]));
    expect(run.removals.get("openrouter")).toEqual([
      "anthropic/claude-sonnet-4.5",
      "google/gemini-flash-latest",
    ]);
  });
});
