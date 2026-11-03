import { describe, expect, it } from "vitest";

import { presets, PRESET_NAMES } from "../src/presets.js";

// @req REQ-MCF-04
describe("presets", () => {
  it("offers exactly the documented preset names", () => {
    expect([...PRESET_NAMES].sort()).toEqual(
      ["active", "free-only", "reasoning", "tool-calling", "vision"],
    );
  });

  it("free-only keeps :free suffixes and zero-cost models", () => {
    expect(presets["free-only"]({ id: "deepseek/deepseek-v4-flash:free" })).toBe(true);
    expect(presets["free-only"]({ id: "x/y", cost: { input: 0, output: 0 } })).toBe(true);
    expect(presets["free-only"]({ id: "x/y", cost: { input: 0.5, output: 1 } })).toBe(false);
  });

  it("free-only treats a missing cost as not free", () => {
    expect(presets["free-only"]({ id: "x/y" })).toBe(false);
  });

  it("capability presets require a positive confirmation", () => {
    expect(presets["tool-calling"]({ id: "x", capabilities: { toolcall: true } })).toBe(true);
    expect(presets["tool-calling"]({ id: "x", capabilities: { toolcall: false } })).toBe(false);
    expect(presets["tool-calling"]({ id: "x" })).toBe(false);
    expect(presets.vision({ id: "x", capabilities: { input: { image: true } } })).toBe(true);
    expect(presets.vision({ id: "x", capabilities: { input: {} } })).toBe(false);
    expect(presets.reasoning({ id: "x", capabilities: { reasoning: true } })).toBe(true);
    expect(presets.reasoning({ id: "x" })).toBe(false);
  });

  it("active keeps only positively-active models", () => {
    expect(presets.active({ id: "x", status: "active" })).toBe(true);
    expect(presets.active({ id: "x", status: "deprecated" })).toBe(false);
    expect(presets.active({ id: "x" })).toBe(false);
  });

  // The real host (Model.Info) uses tier arrays for cost and tools/input/output
  // capability fields; these pin the shapes the V2 catalog actually delivers.
  it("reads the V2 Model.Info shapes", () => {
    expect(
      presets["free-only"]({ id: "x/y", cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } } as never] }),
    ).toBe(true);
    expect(
      presets["free-only"]({
        id: "x/y",
        cost: [
          { input: 0, output: 0 },
          { input: 0.5, output: 2 },
        ],
      }),
    ).toBe(false);
    expect(presets["free-only"]({ id: "x/y", cost: [] })).toBe(false);
    expect(presets["tool-calling"]({ id: "x", capabilities: { tools: true } })).toBe(true);
    expect(presets["tool-calling"]({ id: "x", capabilities: { tools: false } })).toBe(false);
    expect(presets.vision({ id: "x", capabilities: { input: ["text", "image"] } })).toBe(true);
    expect(presets.vision({ id: "x", capabilities: { input: ["text"] } })).toBe(false);
    expect(presets.reasoning({ id: "x", capabilities: { output: ["text", "reasoning"] } })).toBe(true);
    expect(presets.reasoning({ id: "x", capabilities: { output: ["text"] } })).toBe(false);
  });

  it("a zero-cost tier list with a mixed tier is not free", () => {
    expect(presets["free-only"]({ id: "x/y", cost: [{ input: 0, output: 0 }, { input: 1, output: 0 }] })).toBe(false);
  });
});
