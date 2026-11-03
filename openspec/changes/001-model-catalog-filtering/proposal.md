# Proposal: 001-model-catalog-filtering

## Why

OpenCode V2 dropped the V1 `provider.<id>.whitelist` / `blacklist` settings
without a replacement (anomalyco/opencode#49986; PR #54372 only restores exact
ids). Users of OpenRouter — whose catalog has hundreds of entries — cannot trim
the `/models` picker to e.g. only `:free` models without listing every id by
hand, and wildcard support was declined upstream (#42535). This plugin fills
that gap through the V2 plugin API (`model.transform`).

## What changes

New OpenCode V2 plugin `opencode-openrouter-filter`:

- glob include/exclude rules per provider (`*`, `?`, anchored)
- named capability presets: `free-only`, `tool-calling`, `vision`, `reasoning`, `active`
- safety rails: catalog default model protected, all-remove veto, typo warnings
- `disabled` kill switch and an `openrouter-filter` status command

## Impact

- New capability: `model-catalog-filtering`
- New files: `src/`, `test/`, plugin config surface only; no host changes
