# opencode-openrouter-filter

OpenCode V2 plugin that trims the model catalog — the `/models` picker — with
glob patterns and capability presets. Built for OpenRouter's huge catalog
(hide everything but `:free` models in one line), works for any provider.

OpenCode V2 dropped the V1 `whitelist`/`blacklist` provider settings and has no
wildcard support (anomalyco/opencode#49986, #42535). This plugin restores that
through the official `model.transform` plugin API.

## Install

```jsonc
// opencode.json (project) or ~/.config/opencode/opencode.json (global)
{
  "plugin": ["opencode-openrouter-filter"]
}
```

## Configure

Options go on the plugin entry:

```jsonc
{
  "plugin": [
    [
      "opencode-openrouter-filter",
      {
        // applied to every provider matched by its own glob (default "*")
        "defaults": { "presets": ["active"] },
        "rules": [
          {
            "provider": "openrouter",       // glob: "openrouter", "litellm/*", "*"
            "include": ["*:free"],           // keep only these (any match)
            "exclude": ["google/*"],         // always removed; wins over include
            "presets": ["tool-calling"],     // all must hold, on top of the globs
            "allowEmpty": false,             // let a rule remove every model
            "protectDefault": true           // never hide the catalog default
          }
        ],
        "disabled": false
      }
    ]
  ]
}
```

### Patterns

Globs over the **model id** (and over **provider ids** in `provider`):
`*` matches any run of characters, `?` exactly one, everything else is literal.
`"*:free"` matches `deepseek/deepseek-v4-flash:free`. Anchored — no accidental
substring matches.

### Presets

| Preset | Keeps |
| --- | --- |
| `free-only` | ids ending `:free`, or zero input **and** output cost |
| `tool-calling` | models positively marked tool-call capable |
| `vision` | models positively marked image-input capable |
| `reasoning` | models positively marked reasoning |
| `active` | `status: "active"` only (hides alpha/beta/deprecated) |

Unstated capability counts as **no**: a preset only keeps what it can confirm.

### Safety rails

- The catalog's **default model** is never removed unless the rule sets
  `protectDefault: false` — a hidden default breaks new sessions.
- A rule that would empty a provider **removes nothing and warns** unless it
  sets `allowEmpty: true` — the usual cause is a typo.
- Provider patterns matching no provider, include patterns matching no model,
  and unknown presets all produce warnings in the OpenCode log instead of
  silently doing nothing.
- Invalid configuration disables the plugin with one warning; a broken
  transform can never abort catalog assembly.

### Status

The `openrouter-filter` command reports what the last catalog assembly
removed per provider and repeats any warnings.

## Development

```sh
just install     # npm install
just check       # lint + typecheck + tests + build + openspec validate
just test-one test/filter.test.ts
```

Behaviour is specified in `openspec/` (strict-validated); tests tag each
requirement with `@req REQ-MCF-...`. The decision core (`src/filter.ts`) is
pure — the host surface is only touched in `src/adapter.ts` and `src/index.ts`.

## License

MIT
