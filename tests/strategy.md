# Test strategy

The gates in CI enforce this file. If a rule here is not checked by a script, it
is advice, not a rule.

## Layers

| Layer | Runs | Covers | May touch |
| --- | --- | --- | --- |
| unit | `just test` | pattern matcher, presets, config loader, filter decisions | memory only |
| harness | `just test` | `applyToEditor` and `setupPlugin` against fake editors/contexts | memory only |

There is no integration or e2e layer: the host (`@opencode/plugin`) is a peer
dependency, and the plugin's whole contract with it is the structural
`CatalogEditor` surface, exercised with fakes. A future e2e could boot
`createOpencode()` from `@opencode-ai/sdk/v2` and assert the picker contents;
until then nothing may mock the filter decision path itself.

## Requirement mapping

- Every active requirement has at least one test tagged `@req REQ-MCF-...`.
- Every `@req` tag names a requirement that exists in
  `openspec/changes/*/specs/**/spec.md` (or `openspec/specs/` once archived).
  `just spec-lint` fails on a spec without requirements; an untagged
  requirement needs an explicit waiver in the change.
- An untested requirement needs an explicit waiver in the change, or the change
  does not merge.

## Rules

- No network in any test. The plugin must never call out; tests pin that by
  having no network at all.
- No `sleep` for synchronisation; await the actual condition.
- No shared mutable fixtures between test files. Each test owns its catalog.
- Never mock the filter decision path (`src/filter.ts`). Fakes are allowed only
  at the host boundary: `CatalogEditor`, the setup context, and the logger.
- Tests must fail for the reason they claim. A test that passes with the change
  reverted is not covering the change.
- Catalog fixtures are inline, small, and shaped like real OpenRouter ids
  (`vendor/model[:suffix]`).

## Adding a test

1. Name it after the behaviour, not the function: `exclude wins over include`.
2. Tag it with the requirement it verifies.
3. Run it against the unmodified code first and watch it fail.
