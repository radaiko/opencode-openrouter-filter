# model-catalog-filtering Specification (delta)

## ADDED Requirements

### Requirement: REQ-MCF-01 Glob pattern matching
Model and provider patterns SHALL be globs where `*` matches any run of
characters and `?` matches exactly one character, anchored at both ends. All
other characters, including regular-expression metacharacters, SHALL be
treated literally.

#### Scenario: suffix glob for free variants
- **WHEN** the include pattern `*:free` is applied to ids `x/y:free` and `x/y`
- **THEN** only `x/y:free` matches

#### Scenario: no accidental substring match
- **WHEN** the pattern `free` is applied to the id `openrouter/free-model-router`
- **THEN** it does not match

#### Scenario: metacharacters are literals
- **WHEN** the pattern `model(v2)` is applied to ids `model(v2)` and `modelv2`
- **THEN** only `model(v2)` matches

### Requirement: REQ-MCF-02 Include is an allowlist
When a rule has a non-empty `include`, the plugin SHALL remove every model of
the matched providers whose id matches none of the include patterns.

#### Scenario: only free models survive
- **WHEN** a rule with `provider: "openrouter"` and `include: ["*:free"]` is applied to a catalog mixing free and paid models
- **THEN** every paid model is removed and every `:free` model is kept

### Requirement: REQ-MCF-03 Exclude wins over include
A model whose id matches any exclude pattern SHALL be removed even when it
also matches an include pattern.

#### Scenario: excluded id inside an included family
- **WHEN** a rule has `include: ["z-ai/*", "anthropic/claude-sonnet-4.5"]` and `exclude: ["*flash*"]`
- **THEN** `z-ai/glm-5.3-flash` is removed and `anthropic/claude-sonnet-4.5` is kept

### Requirement: REQ-MCF-04 Presets are AND-ed predicates
Every preset named in a rule SHALL hold for a model to be kept, in addition to
the include/exclude patterns. A capability a catalog source does not state
SHALL count as false: a preset only keeps models it can positively confirm.

#### Scenario: two presets intersect
- **WHEN** a rule names presets `free-only` and `tool-calling`
- **THEN** a free model without tool calling is removed and a paid tool-calling model is removed

#### Scenario: unknown capability fails the preset
- **WHEN** a model carries no `capabilities` field and the rule names `tool-calling`
- **THEN** the model is removed

### Requirement: REQ-MCF-05 Free-only preset
The `free-only` preset SHALL keep a model when its id ends with `:free` or its
stated input and output cost are both zero, and SHALL remove it otherwise.

#### Scenario: zero-cost model without suffix
- **WHEN** `free-only` is applied to a model with cost `{input: 0, output: 0}`
- **THEN** the model is kept

#### Scenario: missing cost is not free
- **WHEN** `free-only` is applied to a model with no cost information
- **THEN** the model is removed

### Requirement: REQ-MCF-06 Provider scoping
A rule's `provider` field SHALL be a glob matched against provider ids.
Providers matched by no rule and no defaults block SHALL be left untouched. A
provider pattern that matches no provider SHALL produce a warning and remove
nothing.

#### Scenario: unrelated provider untouched
- **WHEN** a rule scopes to `openrouter` and the catalog also has `litellm`
- **THEN** no `litellm` model is removed

#### Scenario: pattern names no provider
- **WHEN** a rule's provider pattern `nope` matches no configured provider
- **THEN** a warning names the pattern and nothing is removed

### Requirement: REQ-MCF-07 Catalog default model protection
Unless the rule sets `protectDefault: false`, the plugin SHALL NOT remove the
model the catalog marks as default, even when it fails the rule, so that new
sessions keep a selectable model.

#### Scenario: protected default survives
- **WHEN** an include-only rule would remove the catalog's default model
- **THEN** the default model is not among the removals

#### Scenario: opt-out removes it too
- **WHEN** the rule sets `protectDefault: false` and would remove the default model
- **THEN** the default model is removed

### Requirement: REQ-MCF-08 Empty-catalog veto
Unless the rule sets `allowEmpty: true`, a rule that would leave a matched
provider with zero models SHALL remove nothing from that provider and warn.
The protected default model counts as kept.

#### Scenario: typo guard
- **WHEN** `include: ["nope/*"]` would remove all four models of a provider
- **THEN** nothing is removed and the warning reports the would-be count

#### Scenario: deliberate emptying
- **WHEN** the same rule sets `allowEmpty: true`
- **THEN** all four models are removed

### Requirement: REQ-MCF-09 Configuration validation
The plugin SHALL reject (fail closed, filtering inactive) options whose shape
is wrong: a rule without a string `provider`, non-array `include`/`exclude`,
or non-array `presets`. Unknown preset names and empty patterns SHALL be
skipped with a warning instead of failing.

#### Scenario: missing provider is rejected
- **WHEN** a rule omits `provider`
- **THEN** the configuration is rejected and no filtering is registered

#### Scenario: unknown preset downgraded
- **WHEN** a rule names the preset `bogus`
- **THEN** the rest of the rule applies and a warning names `bogus`

### Requirement: REQ-MCF-10 No-op warnings
The plugin SHALL warn when an include pattern matches no model in any matched
provider, when a rule removes nothing while enabled, and when an unknown
preset is skipped — the signatures of typos in a long-lived config.

#### Scenario: dead include pattern
- **WHEN** a rule includes `["*:free", "typo/*"]` and no id matches `typo/*`
- **THEN** the warning names `typo/*`

### Requirement: REQ-MCF-11 Defaults block merge
A `defaults` block SHALL apply its patterns and presets to every provider
matched by its own `provider` glob (default `*`). When a rule and the defaults
both match a provider, include and exclude lists SHALL be concatenated and
presets unioned; `allowEmpty` and `protectDefault` come from the rule.

#### Scenario: global exclude with per-provider include
- **WHEN** defaults exclude `google/*` for all providers and a rule includes `*:free` for `openrouter`
- **THEN** non-free and google models are removed from `openrouter`, and providers matched only by defaults keep their non-excluded models

### Requirement: REQ-MCF-12 Disabled kill switch
When `disabled` is true the plugin SHALL leave the catalog completely
untouched, emit no filtering warnings, and its status command SHALL report the
disabled state.

#### Scenario: disabled removes nothing
- **WHEN** `disabled: true` and rules that would otherwise remove models
- **THEN** no provider has any removal and no warning is produced

### Requirement: REQ-MCF-13 Plugin wiring
The plugin SHALL register exactly one catalog transform and one command named
`openrouter-filter`. Invalid configuration SHALL deactivate filtering with a
single warning naming the error. A failure inside the transform SHALL be
logged as a warning and must not abort catalog assembly.

#### Scenario: status command exists
- **WHEN** the plugin sets up with valid options
- **THEN** a command named `openrouter-filter` is registered and reports the last run

#### Scenario: broken host editor is contained
- **WHEN** the catalog editor throws during a transform
- **THEN** the error is logged as a warning and the transform returns normally

### Requirement: REQ-MCF-14 Provider-settings discovery
When the `routing` option block is present and enabled, the plugin SHALL read
OpenRouter routing cutoffs from the user's OpenCode config at
`providers.<id>.body.provider`, honouring the wire keys `max_price`,
`preferred_min_throughput` and `preferred_max_latency`, and SHALL let plugin
options `routing.providers` override them. Unrelated keys SHALL be ignored;
malformed cutoffs SHALL deactivate the routing filter with a warning without
disabling rule-based filtering.

#### Scenario: cutoffs come from the config file
- **WHEN** a config file contains `providers.openrouter.body.provider.max_price.prompt = 0.5`
- **THEN** the routing filter for provider `openrouter` enforces a prompt price ceiling of $0.5 per million tokens

#### Scenario: discovery order and overrides
- **WHEN** cutoffs appear in the global config, `$OPENCODE_CONFIG` and the project `opencode.json`
- **THEN** later files override earlier ones, camelCase aliases are accepted, and `routing.configFile` restricts discovery to that one file

#### Scenario: junk in the routing block is tolerated, bad cutoffs are not
- **WHEN** a `body.provider` block contains unknown keys and one malformed cutoff
- **THEN** the routing filter deactivates with a warning naming the offending field and rule filtering still runs

### Requirement: REQ-MCF-15 Price gate mirrors max_price
For a provider with routing cutoffs, the plugin SHALL hide every model whose
catalog `cost` tiers all bust `max_price`, comparing tier `input` against
`prompt` and tier `output` against `completion` (both USD per million
tokens); a model is kept when at least one tier fits or when the catalog
carries no price data for it.

#### Scenario: over-priced model hidden
- **WHEN** cutoffs set `max_price: {prompt: 0.5, completion: 2.5}` and a model's cheapest tier costs `input 2, output 8`
- **THEN** that model is hidden by routing

#### Scenario: any fitting tier keeps the model
- **WHEN** the same cutoffs meet a model with tiers `{input 5, output 20}` and `{input 0.3, output 1}`
- **THEN** the model is kept

### Requirement: REQ-MCF-16 Throughput and latency cutoffs via endpoint stats
For a provider with routing cutoffs, when `preferred_min_throughput` or
`preferred_max_latency` is set the plugin SHALL judge models against
per-endpoint percentiles from the OpenRouter endpoints API: a model is kept
when at least one endpoint meets every specified cutoff, and kept whenever no
measurement contradicts it. The stats fetch SHALL be asynchronous, cached,
skipped for models already hidden by the price gate, and followed by a
catalog reload that re-runs filtering.

#### Scenario: cutoff units and semantics
- **WHEN** throughput cutoffs are tokens per second compared with `>=` and latency cutoffs are seconds compared against reported milliseconds with `<= cutoff × 1000`, a bare number applying to p50
- **THEN** a model is judged by those comparisons against each endpoint's percentiles

#### Scenario: slow model hidden after stats land
- **WHEN** cutoffs require `preferred_min_throughput: {p50: 60}` and every endpoint of a model reports p50 of 20 tokens/sec
- **THEN** the model is visible before the stats fetch and hidden after it completes

#### Scenario: no stats means no hiding
- **WHEN** the endpoints API returns null percentiles, yields no endpoints, or fails for a model
- **THEN** the model stays visible

#### Scenario: price-hidden models never hit the stats API
- **WHEN** a model busts `max_price`
- **THEN** no endpoint request is made for it

### Requirement: REQ-MCF-17 Routing respects the safety rails
Routing hides SHALL honour the same protection rails as rule hides: the
catalog default model is never hidden by routing, and a routing pass that
would remove every model of a provider is skipped with a warning. Routing
hides combine with rule removals without double counting.

#### Scenario: default survives routing
- **WHEN** routing cutoffs reject every model of a provider and one of them is the catalog default
- **THEN** only the default stays visible and a warning is emitted
