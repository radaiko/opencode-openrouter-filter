import { describe, expect, it } from "vitest";

import { globMatch, matchAny } from "../src/pattern.js";

// @req REQ-MCF-01
describe("glob matching", () => {
  it("matches a suffix glob like OpenRouter free variants", () => {
    expect(globMatch("*:free", "anthropic/claude-sonnet-4.5:free")).toBe(true);
    expect(globMatch("*:free", "anthropic/claude-sonnet-4.5")).toBe(false);
  });

  it("matches prefixes and middles with *", () => {
    expect(globMatch("anthropic/*", "anthropic/claude-sonnet-4.5")).toBe(true);
    expect(globMatch("*/gpt-*", "openai/gpt-6.1-sol")).toBe(true);
    expect(globMatch("*flash*", "litellm/qwen3.8-flash-next")).toBe(true);
  });

  it("matches exactly one character with ?", () => {
    expect(globMatch("gpt-?", "gpt-4")).toBe(true);
    expect(globMatch("gpt-?", "gpt-4o")).toBe(false);
  });

  it("is anchored: no accidental substring matches", () => {
    expect(globMatch("free", "openrouter/free-model-router")).toBe(false);
    expect(globMatch("free", "free")).toBe(true);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    expect(globMatch("model(v2)", "model(v2)")).toBe(true);
    expect(globMatch("model(v2)", "modelv2")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
  });

  it("matchAny is true when any pattern matches", () => {
    expect(matchAny(["x/*", "*:free"], "a/b:free")).toBe(true);
    expect(matchAny([], "a/b")).toBe(false);
  });
});
