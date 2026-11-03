// End-to-end validation of the plugin against the REAL OpenCode host.
//
// Boots the embedded host (@opencode/sdk `create`) with the built plugin
// registered, seeds deterministic providers through config content, and
// asserts what the model picker API (`model.list` / `model.default`) reports.
//
// Run from the repo root (needs devDeps installed):
//   XDG_CONFIG_HOME=... XDG_DATA_HOME=... XDG_STATE_HOME=... node test/e2e-filter.mjs
// The XDG dirs must point at a scratch location so the developer's own
// global config, plugins and credentials never load.
import { OpenCode } from "@opencode/sdk";

import { setupPlugin } from "../dist/index.js";

const SILENT = { info() {}, warn() {} };

/** V2 ModelConfig shapes: cost tiers are {input,output,cache}; capabilities are explicit. */
const zeroCost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
const paidCost = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } };

const e2etestModels = {
  "free/a:free": {
    name: "Free A",
    cost: zeroCost,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 128000, output: 8192 },
  },
  "free/b:free": {
    name: "Free B",
    cost: zeroCost,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 128000, output: 8192 },
  },
  "paid/c": {
    name: "Paid C",
    cost: paidCost,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 64000 },
  },
  "misc/hidden-d": {
    name: "Hidden D",
    cost: paidCost,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 128000, output: 8192 },
  },
};

const e2etest2Models = {
  keepme: { name: "Keep Me", limit: { context: 32000, output: 4096 } },
};

function providerConfig() {
  const provider = (name, models) => ({
    name,
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: "e2e-key", baseURL: "http://127.0.0.1:1/v1" },
    models,
  });
  return {
    e2etest: provider("E2E Test", e2etestModels),
    e2etest2: provider("E2E Test 2", e2etest2Models),
  };
}

function pluginWith(options, preTransforms = []) {
  return {
    id: "openrouter-filter",
    setup: async (context) => {
      // Register scenario shapers first: model transforms run in global
      // registration order, so the filter must see whatever the shapers wrote.
      for (const transform of preTransforms) {
        await context.model.transform(transform);
      }
      setupPlugin({ ...context, options }, SILENT);
    },
  };
}

let dirSeq = 0;

async function withHost(pluginOptions, extraConfig, probe, preTransforms = []) {
  const config = {
    provider: providerConfig(),
    ...extraConfig,
  };
  const directory = `/tmp/opencode/e2e-host/run-${process.pid}-${dirSeq++}`;
  const app = await OpenCode.create({
    plugins: [pluginWith(pluginOptions, preTransforms)],
    config: { directory, content: JSON.stringify(config), project: false, claude: false },
    models: { fetch: false },
    events: { persist: false },
  });
  try {
    // Plugin setup activates lazily on the first location-scoped request;
    // warm the catalog so commands/transforms are registered before probing.
    await app.model.list();
    return await probe(app);
  } finally {
    await app.close();
  }
}

async function ids(app, providerID) {
  const res = await app.model.list();
  return res.data
    .filter((m) => m.providerID === providerID)
    .map((m) => m.id)
    .sort();
}

let failures = 0;
async function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

const all = ["free/a:free", "free/b:free", "misc/hidden-d", "paid/c"];

// Config-seeded capabilities are normalized by the host (always
// input ["text","image"], output ["text"], tools true), so shaper transforms
// run before the filter (same plugin, registered first) and write truthful
// capability bits into the catalog.
const shapeCapabilities = (capabilities) => (editor) => {
  for (const [modelID, caps] of capabilities) {
    editor.update("e2etest", modelID, (m) => {
      m.capabilities = caps;
    });
  }
};

// 1. no rules: everything stays
await check(
  "no rules keeps the full catalog",
  await withHost({}, {}, (app) => ids(app, "e2etest")),
  all,
);

// 2. free-only preset hides paid models (zero-cost tiers and :free suffix)
await check(
  "free-only preset keeps only free models",
  await withHost({ rules: [{ provider: "e2etest", presets: ["free-only"] }] }, {}, (app) =>
    ids(app, "e2etest"),
  ),
  ["free/a:free", "free/b:free"],
);

// 3. presets are AND-ed. Seeded capabilities.tools is normalized to true by
//    the host, so free/b:free gets its lack of tools written in by a shaper.
await check(
  "free-only AND tool-calling",
  await withHost(
    { rules: [{ provider: "e2etest", presets: ["free-only", "tool-calling"] }] },
    {},
    (app) => ids(app, "e2etest"),
    [shapeCapabilities([["free/b:free", { tools: false, input: ["text"], output: ["text"] }]])],
  ),
  ["free/a:free"],
);

// 4. include glob + exclude wins
await check(
  "include glob with exclude winning",
  await withHost(
    {
      rules: [
        { provider: "e2etest", include: ["free/*", "paid/*", "misc/*"], exclude: ["misc/*"] },
      ],
    },
    {},
    (app) => ids(app, "e2etest"),
  ),
  ["free/a:free", "free/b:free", "paid/c"],
);

// 5. vision and reasoning presets read the V2 capability lists (shapers above).
await check(
  "vision preset",
  await withHost(
    { rules: [{ provider: "e2etest", include: ["free/*", "paid/c"], presets: ["vision"] }] },
    {},
    (app) => ids(app, "e2etest"),
    [shapeCapabilities([["free/b:free", { tools: false, input: ["text"], output: ["text"] }]])],
  ),
  ["free/a:free", "paid/c"],
);
await check(
  "reasoning preset",
  await withHost(
    { rules: [{ provider: "e2etest", include: ["free/*", "paid/c"], presets: ["reasoning"] }] },
    {},
    (app) => ids(app, "e2etest"),
    [
      shapeCapabilities([
        ["free/b:free", { tools: false, input: ["text"], output: ["text"] }],
        ["free/a:free", { tools: true, input: ["text", "image"], output: ["text", "reasoning"] }],
        ["paid/c", { tools: true, input: ["text"], output: ["text", "reasoning"] }],
      ]),
    ],
  ),
  // free/b:free lacks reasoning output and is dropped; the two shaped models keep it.
  ["free/a:free", "paid/c"],
);

// 6. catalog default model is protected. The location-scoped default is only
//    populated once something "uses" a model, so a pre-transform sets it,
//    exactly like the host would.
const setDefaultTransform = (providerID, modelID) => (editor) => {
  editor.default.set(providerID, modelID);
};

await check(
  "protected default survives free-only",
  await withHost(
    { rules: [{ provider: "e2etest", presets: ["free-only"] }] },
    {},
    (app) => ids(app, "e2etest"),
    [setDefaultTransform("e2etest", "paid/c")],
  ),
  ["free/a:free", "free/b:free", "paid/c"],
);

// 7. protectDefault: false removes even the default
await check(
  "protectDefault false removes the default",
  await withHost(
    {
      rules: [{ provider: "e2etest", presets: ["free-only"], protectDefault: false }],
    },
    {},
    (app) => ids(app, "e2etest"),
    [setDefaultTransform("e2etest", "paid/c")],
  ),
  ["free/a:free", "free/b:free"],
);

// 8. empty-catalog veto: a typo include removes nothing
await check(
  "empty-catalog veto keeps everything",
  await withHost({ rules: [{ provider: "e2etest", include: ["nope/*"] }] }, {}, (app) =>
    ids(app, "e2etest"),
  ),
  all,
);

// 9. allowEmpty: true lets the same rule empty the provider
await check(
  "allowEmpty empties the provider",
  await withHost(
    { rules: [{ provider: "e2etest", include: ["nope/*"], allowEmpty: true }] },
    {},
    (app) => ids(app, "e2etest"),
  ),
  [],
);

// 10. provider scoping: a rule for e2etest2 leaves e2etest alone
await check(
  "unmatched provider untouched",
  await withHost(
    { rules: [{ provider: "e2etest2", include: ["nope/*"], allowEmpty: true }] },
    {},
    async (app) => {
      const scoped = await ids(app, "e2etest");
      const emptied = await ids(app, "e2etest2");
      return [scoped, emptied];
    },
  ),
  [all, []],
);

// 11. disabled kill switch
await check(
  "disabled removes nothing",
  await withHost(
    { disabled: true, rules: [{ provider: "e2etest", include: ["nope/*"], allowEmpty: true }] },
    {},
    (app) => ids(app, "e2etest"),
  ),
  all,
);

// 12. status command is registered in the host
await check(
  "status command registered",
  await withHost({ rules: [] }, {}, async (app) => {
    const commands = await app.command.list({});
    return (commands.data ?? []).some((c) => c.name === "openrouter-filter");
  }),
  true,
);

console.log(failures === 0 ? "\nE2E: ALL PASS" : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
