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
import { createServer } from "node:http";

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

// 13. on-demand loading: the host pulls its model catalog from the models.dev
//     source in the background after startup (this is how OpenRouter's catalog
//     actually arrives). A local server stands in for that source and holds
//     the response until released, so the first picker read happens while the
//     catalog is still in flight; once it lands, the catalog rebuild re-runs
//     the model transforms and the same rules must apply.
await check(
  "late-loaded catalog is filtered",
  await (async () => {
    const directory = `/tmp/opencode/e2e-host/run-${process.pid}-${dirSeq++}`;
    // models.dev v2 wire shape: provider record with per-model records.
    const mkModel = (modelID, price) => ({
      id: modelID,
      type: "chat",
      name: modelID,
      release_date: "2026-01-01",
      modalities: { input: ["text"], output: ["text"] },
      capabilities: { tools: { supported: true }, reasoning: { supported: false } },
      limit: { context: 100000, output: 4096 },
      cost: { text: { input: { price }, output: { price: price * 4 } } },
      api: {
        "chat-completions": {
          base_url: "http://127.0.0.1:1/v1",
          sdk: {
            aisdk: "@ai-sdk/openai-compatible",
            opencodeai: "@opencode/ai/providers/openai-compatible",
          },
        },
      },
    });
    const catalog = {
      e2elate: {
        id: "e2elate",
        name: "E2E Late",
        env: ["E2ELATE_API_KEY"],
        models: { "free/a:free": mkModel("free/a:free", 0), "paid/b": mkModel("paid/b", 3) },
      },
    };
    // Gate the response so the test decides when the "network" delivers.
    let release;
    const delivered = new Promise((resolve) => {
      release = resolve;
    });
    const server = createServer((_req, res) => {
      delivered.then(() => {
        res.writeHead(200, { "content-type": "application/json", etag: 'W/"e2e-1"' });
        res.end(JSON.stringify(catalog));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const app = await OpenCode.create({
      plugins: [
        pluginWith({ rules: [{ provider: "e2elate", include: ["*:free"] }] }),
      ],
      config: {
        directory,
        content: JSON.stringify({
          provider: {
            // Provider declared like the user's openrouter entry: connection
            // info only, the model list comes from the source on demand.
            e2elate: {
              name: "E2E Late",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "e2e-key", baseURL: "http://127.0.0.1:1/v1" },
            },
          },
        }),
        project: false,
        claude: false,
      },
      models: { url: `http://127.0.0.1:${server.address().port}`, fetch: true },
      events: { persist: false },
    });
    try {
      const before = await ids(app, "e2elate"); // catalog still in flight
      release();
      // Wait for the fetch to land and the catalog rebuild to settle.
      let after = before;
      for (let i = 0; i < 100 && after.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        after = await ids(app, "e2elate");
      }
      return [before, after];
    } finally {
      await app.close();
      server.close();
    }
  })(),
  [[], ["free/a:free"]],
);

// 14. routing filter: the plugin reads the user's own OpenCode config
//     (providers.<id>.body.provider — max_price, preferred_min_throughput,
//     preferred_max_latency) and hides models that cannot satisfy it. Price
//     uses the catalog cost; throughput/latency use the OpenRouter endpoints
//     API, served here by a local mock. Stats arrive asynchronously: first
//     the price gate acts, then a reload re-filters with the measurements.
await check(
  "provider-settings routing filter",
  await (async () => {
    const configFile = `/tmp/opencode/e2e-routing-${process.pid}.json`;
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(
      configFile,
      JSON.stringify({
        // Exactly the shape of the user's live openrouter entry.
        providers: {
          e2erouted: {
            body: {
              provider: {
                zdr: true,
                data_collection: "deny",
                sort: "price",
                max_price: { prompt: 0.5, completion: 2.5 },
                preferred_min_throughput: { p50: 60, p90: 30 },
                preferred_max_latency: { p50: 1.5, p90: 3 },
              },
            },
          },
        },
      }),
    );
    // Endpoint percentiles per model: throughput tokens/sec, latency ms
    // (the units the real API reports).
    const endpointStats = {
      "fast/one": [{ throughput_last_30m: { p50: 120, p75: 100, p90: 80, p99: 60 }, latency_last_30m: { p50: 800, p75: 1000, p90: 1200, p99: 2000 } }],
      "slow/one": [{ throughput_last_30m: { p50: 20, p90: 12 }, latency_last_30m: { p50: 400, p90: 700 } }],
      "slowstart/one": [{ throughput_last_30m: { p50: 100, p90: 70 }, latency_last_30m: { p50: 2500, p90: 4000 } }],
      "nostats/one": [{ throughput_last_30m: null, latency_last_30m: null }],
      "partial/one": [{ throughput_last_30m: { p50: 100, p90: 70 }, latency_last_30m: null }],
    };
    const requested = [];
    const statsServer = createServer((req, res) => {
      const match = /^\/api\/v1\/models\/(.+)\/endpoints$/.exec(req.url ?? "");
      requested.push(match ? match[1] : req.url);
      const modelID = match?.[1];
      const endpoints = modelID !== undefined ? endpointStats[modelID] : undefined;
      // Hold the response so the price-only phase is observable before the
      // async stats pass settles the catalog.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(endpoints ? { data: { endpoints } } : { data: { endpoints: [] } }));
      }, 250);
    });
    await new Promise((resolve) => statsServer.listen(0, "127.0.0.1", resolve));
    // The host drops `cost` from config-seeded models (published as []), so a
    // pre-transform shaper writes the price tiers into the catalog draft —
    // the same pattern the capability shapers use above.
    const costSeed = {
      "fast/one": [{ input: 0.2, output: 1.0, cache: { read: 0, write: 0 } }],
      "slow/one": [{ input: 0.3, output: 1.5, cache: { read: 0, write: 0 } }],
      "slowstart/one": [{ input: 0.2, output: 1.0, cache: { read: 0, write: 0 } }],
      "nostats/one": [{ input: 0.3, output: 1.0, cache: { read: 0, write: 0 } }],
      "partial/one": [{ input: 0.2, output: 1.0, cache: { read: 0, write: 0 } }],
      "pricey/one": [{ input: 2.0, output: 8.0, cache: { read: 0, write: 0 } }],
    };
    const seedCost = (editor) => {
      for (const [modelID, cost] of Object.entries(costSeed)) {
        editor.update("e2erouted", modelID, (model) => {
          model.cost = cost;
        });
      }
    };
    const mk = (name) => ({
      name,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 8192 },
    });
    try {
      const result = await withHost(
        { routing: { configFile, statsBaseUrl: `http://127.0.0.1:${statsServer.address().port}/api/v1` } },
        {
          provider: {
            ...providerConfig(),
            e2erouted: {
              name: "E2E Routed",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "e2e-key", baseURL: "http://127.0.0.1:1/v1" },
              models: {
                "fast/one": mk("Fast One"),
                "slow/one": mk("Slow One"),
                "slowstart/one": mk("Slow Start"),
                "nostats/one": mk("No Stats"),
                "partial/one": mk("Partial"),
                "pricey/one": mk("Pricey One"),
              },
            },
          },
        },
        async (app) => {
          // First read: catalog visible, stats not yet fetched (price-only view).
          const first = await ids(app, "e2erouted");
          // Poll until the async stats pass has re-filtered the catalog.
          const settled = ["fast/one", "nostats/one", "partial/one"];
          let last = first;
          for (let i = 0; i < 100; i++) {
            last = await ids(app, "e2erouted");
            if (JSON.stringify(last) === JSON.stringify(settled)) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return [first, last, requested.some((id) => id === "pricey/one")];
        },
        [seedCost],
      );
      // Before stats: only the price gate has acted. After: throughput and
      // latency cutoffs applied; pricey/one never reached the stats server.
      return [
        result[0],
        result[1],
        result[2],
      ];
    } finally {
      statsServer.close();
      rmSync(configFile, { force: true });
    }
  })(),
  [
    // first: price gate only — pricey hidden, perf models still visible
    ["fast/one", "nostats/one", "partial/one", "slow/one", "slowstart/one"],
    // settled: no endpoint meets the cutoffs for slow/slowstart
    ["fast/one", "nostats/one", "partial/one"],
    // price-hidden models are never fetched from the stats API
    false,
  ],
);

// 15. age gate: defaults.maxAgeDays hides models whose catalog release date
//     is older than the cutoff. The host normalizes config-seeded models
//     without time data, so a pre-transform shaper writes time.released into
//     the catalog drafts — the same pattern as seedCost above. Models without
//     a release date stay visible.
await check(
  "maxAgeDays auto-hides stale models",
  await (async () => {
    const DAY = 86_400_000;
    const stamps = {
      "free/a:free": Date.now() - 10 * DAY,
      "free/b:free": Date.now() - 500 * DAY,
      "paid/c": Date.now() - 400 * DAY,
      // misc/hidden-d gets no stamp: the host normalizes it to released 0,
      // which the gate reads as "no date" and keeps
    };
    const seedAges = (editor) => {
      for (const [modelID, released] of Object.entries(stamps)) {
        editor.update("e2etest", modelID, (model) => {
          model.time = { ...model.time, released };
        });
      }
    };
    return withHost({ defaults: { maxAgeDays: 365 } }, {}, async (app) => {
      return [await ids(app, "e2etest"), await ids(app, "e2etest2")];
    }, [seedAges]);
  })(),
  [
    // stale free/b:free and paid/c hidden; misc/hidden-d kept (released 0)
    ["free/a:free", "misc/hidden-d"],
    // provider without real release dates is untouched
    ["keepme"],
  ],
);

console.log(failures === 0 ? "\nE2E: ALL PASS" : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
