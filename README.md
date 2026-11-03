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

### Routing filter (provider settings)

If your OpenCode config already tells OpenRouter how to route — e.g.

```json
"providers": {
  "openrouter": {
    "body": {
      "provider": {
        "max_price": { "prompt": 0.5, "completion": 2.5 },
        "preferred_min_throughput": { "p50": 60, "p90": 30 },
        "preferred_max_latency": { "p50": 1.5, "p90": 3 }
      }
    }
  }
}
```

then enabling `routing` hides catalog models that could never satisfy those
settings, so the picker matches what you actually get routed to:

- `max_price` (USD per million tokens) is a hard gate against the catalog
  price tiers; a model survives if any tier fits.
- `preferred_min_throughput` (tokens/sec) and `preferred_max_latency`
  (seconds; a bare number means p50) are judged against OpenRouter's
  per-endpoint percentile stats (`throughput_last_30m` /
  `latency_last_30m`). A model survives if **any** endpoint meets **all**
  specified cutoffs.

Stats come from `GET {statsBaseUrl}/models/{author}/{slug}/endpoints`, the
same API the OpenRouter site uses. That API returns real percentiles only
when authenticated, so set `routing.apiKey` (or export `OPENROUTER_API_KEY`);
without a key — or whenever stats are missing or the request fails — models
are **kept**, never hidden on absent data. Stats are fetched in the
background after startup (bounded concurrency, cached for `statsTtlMs`), then
the catalog reloads and re-filters; price-ho models are hidden immediately
and never fetched. Routing hides obey the same safety rails as rules: the
default model survives and a provider is never emptied outright.

```jsonc
"plugins": [{ "package": "opencode-openrouter-filter", "options": {
  "rules": [ /* ... */ ],
  "routing": {
    // optional; cutoffs are auto-discovered from your opencode config files
    // "configFile": "/path/to/opencode.json",
    // "providers": { "openrouter": { "max_price": { "prompt": 0.5 } } },
    "apiKey": "{{ env:OPENROUTER_API_KEY }}",   // optional, for real stats
    "statsTtlMs": 300000,                        // optional
    "enabled": true                              // optional kill switch
  }
} }]
```

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
