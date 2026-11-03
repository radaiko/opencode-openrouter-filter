import { describe, expect, it } from "vitest";

import { setupPlugin, PLUGIN_ID, type PluginLogger, type SetupContext } from "../src/index.js";
import type { CatalogEditor } from "../src/adapter.js";

interface Recorded {
  modelCallbacks: Array<(editor: CatalogEditor) => void>;
  commandAdds: Array<{ name: string; execute: (input: unknown) => Promise<void> }>;
}

function fakeContext(options: Record<string, unknown>): { context: SetupContext; recorded: Recorded } {
  const recorded: Recorded = { modelCallbacks: [], commandAdds: [] };
  const context: SetupContext = {
    options,
    model: {
      transform: async (callback) => {
        recorded.modelCallbacks.push(callback);
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (callback) => {
        callback({
          add: (definition) => {
            recorded.commandAdds.push(definition as never);
          },
        });
        return { dispose: async () => {} };
      },
    },
  };
  return { context, recorded };
}

function fakeLogger(): PluginLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
  };
}

// @req REQ-MCF-13
describe("setupPlugin", () => {
  it("registers a catalog transform and a status command", async () => {
    const { context, recorded } = fakeContext({ rules: [{ provider: "openrouter", include: ["*:free"] }] });
    const result = setupPlugin(context, fakeLogger());
    await Promise.resolve();
    expect(result?.config.rules).toHaveLength(1);
    expect(recorded.modelCallbacks).toHaveLength(1);
    expect(recorded.commandAdds.map((c) => c.name)).toEqual([PLUGIN_ID]);
  });

  it("logs warnings from config validation at setup", () => {
    const { context } = fakeContext({ rules: [{ provider: "p", presets: ["bogus"] }] });
    const logger = fakeLogger();
    setupPlugin(context, logger);
    expect(logger.lines.some((l) => l.includes("bogus"))).toBe(true);
  });

  it("activates nothing on invalid configuration and says so", () => {
    const { context, recorded } = fakeContext({ rules: [{ include: ["*:free"] }] });
    const logger = fakeLogger();
    const result = setupPlugin(context, logger);
    expect(result).toBeUndefined();
    expect(recorded.modelCallbacks).toHaveLength(0);
    expect(logger.lines.join("\n")).toContain("invalid configuration");
  });

  it("skips filtering when disabled but keeps the status command", async () => {
    const logger = fakeLogger();
    const { context, recorded } = fakeContext({ disabled: true });
    const result = setupPlugin(context, logger);
    expect(result?.config.disabled).toBe(true);
    await recorded.commandAdds[0]?.execute({ sessionID: "s", prompt: "", delivery: {} });
    expect(logger.lines.join("\n")).toContain("disabled by configuration");
  });

  it("the status command reports the last run", async () => {
    const logger = fakeLogger();
    const { context, recorded } = fakeContext({
      rules: [{ provider: "openrouter", include: ["*:free"], protectDefault: false, allowEmpty: false }],
    });
    const result = setupPlugin(context, logger);
    recorded.modelCallbacks[0]?.({
      list: () => [
        { id: "a/free:free", providerID: "openrouter" },
        { id: "a/paid", providerID: "openrouter" },
      ],
      get: () => undefined,
      update: () => {},
      default: { get: () => undefined },
    });
    expect(result?.lastRun()?.removedCount).toBe(1);
    await recorded.commandAdds[0]?.execute({ sessionID: "s", prompt: "", delivery: {} });
    expect(logger.lines.join("\n")).toContain("hidden 1 model(s)");
  });

  it("a throwing editor is contained: filtering errors become warnings", () => {
    const logger = fakeLogger();
    const { context } = fakeContext({ rules: [{ provider: "openrouter", include: ["*:free"] }] });
    setupPlugin(context, logger);
    const boom: CatalogEditor = {
      list: () => {
        throw new Error("host exploded");
      },
      get: () => undefined,
      update: () => {},
      default: { get: () => undefined },
    };
    const { context: ctx2, recorded: rec2 } = fakeContext({
      rules: [{ provider: "openrouter", include: ["*:free"] }],
    });
    setupPlugin(ctx2, logger);
    expect(() => rec2.modelCallbacks[0]?.(boom)).not.toThrow();
    expect(logger.lines.join("\n")).toContain("failed to apply filtering");
  });
});
