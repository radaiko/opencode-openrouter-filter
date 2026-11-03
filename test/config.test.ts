import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

// @req REQ-MCF-09
describe("loadConfig", () => {
  it("accepts the documented shape", () => {
    const config = loadConfig({
      defaults: { presets: ["active"] },
      rules: [
        {
          provider: "openrouter",
          include: ["*:free"],
          exclude: ["google/*"],
          presets: ["tool-calling"],
        },
      ],
    });
    expect(config.disabled).toBe(false);
    expect(config.rules[0]).toEqual({
      provider: "openrouter",
      include: ["*:free"],
      exclude: ["google/*"],
      presets: ["tool-calling"],
      allowEmpty: false,
      protectDefault: true,
    });
    expect(config.defaults?.presets).toEqual(["active"]);
    expect(config.warnings).toEqual([]);
  });

  it("treats missing options as an empty enabled config", () => {
    expect(loadConfig(undefined).rules).toEqual([]);
    expect(loadConfig({}).rules).toEqual([]);
  });

  it("rejects a rule without a provider", () => {
    expect(() => loadConfig({ rules: [{ include: ["*:free"] }] })).toThrow(ConfigError);
  });

  it("rejects non-string pattern arrays", () => {
    expect(() => loadConfig({ rules: [{ provider: "p", include: [1] }] })).toThrow(ConfigError);
    expect(() => loadConfig({ rules: [{ provider: "p", exclude: "x" }] })).toThrow(ConfigError);
  });

  it("skips unknown presets with a warning instead of failing", () => {
    const config = loadConfig({ rules: [{ provider: "p", presets: ["tool-calling", "nope"] }] });
    expect(config.rules[0]?.presets).toEqual(["tool-calling"]);
    expect(config.warnings.join(" ")).toContain("nope");
  });

  it("skips empty patterns with a warning", () => {
    const config = loadConfig({ rules: [{ provider: "p", include: ["", " *:free "] }] });
    expect(config.rules[0]?.include).toEqual(["*:free"]);
    expect(config.warnings.join(" ")).toContain("empty pattern");
  });

  // @req REQ-MCF-08
  it("protects the default model and the non-empty catalog by default", () => {
    const config = loadConfig({ rules: [{ provider: "p" }] });
    expect(config.rules[0]?.protectDefault).toBe(true);
    expect(config.rules[0]?.allowEmpty).toBe(false);
  });

  it("honours explicit opt-outs", () => {
    const config = loadConfig({
      rules: [{ provider: "p", protectDefault: false, allowEmpty: true }],
    });
    expect(config.rules[0]?.protectDefault).toBe(false);
    expect(config.rules[0]?.allowEmpty).toBe(true);
  });
});
