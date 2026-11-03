import { Plugin } from "@opencode/plugin";

import { applyToEditor, type CatalogEditor } from "./adapter.js";
import { ConfigError, loadConfig, type ValidatedConfig } from "./config.js";
import type { FilterRun } from "./filter.js";
import { createRoutingState, type RoutingState } from "./routing.js";

export const PLUGIN_ID = "openrouter-filter";

/** Where the last run's outcome goes. The host shows console output in its logs. */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SetupContext {
  readonly options: Record<string, unknown>;
  readonly model: {
    readonly transform: (callback: (editor: CatalogEditor) => void) => Promise<unknown>;
    /** Rebuild the catalog, re-running transforms; used after stats arrive. */
    readonly reload?: () => Promise<unknown>;
  };
  readonly command: {
    readonly transform: (callback: (editor: { add(definition: unknown): void }) => void) => Promise<unknown>;
  };
  readonly location?: { readonly directory?: string };
}

export function setupPlugin(
  context: SetupContext,
  logger: PluginLogger = console,
): { config: ValidatedConfig; lastRun: () => FilterRun | undefined } | undefined {
  let config: ValidatedConfig;
  try {
    config = loadConfig(context.options);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn(`[${PLUGIN_ID}] invalid configuration: ${error.message}; filtering is not active`);
      return undefined;
    }
    throw error;
  }
  for (const warning of config.warnings) logger.warn(`[${PLUGIN_ID}] ${warning}`);

  // Provider-settings filter (max_price / throughput / latency cutoffs read
  // from the user's OpenCode config). Catalog data has no measured stats, so
  // stats are fetched after the first pass and a reload re-runs the filter.
  let routing: RoutingState | undefined;
  try {
    routing = createRoutingState(
      context.options.routing,
      context.location?.directory ?? process.cwd(),
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn(`[${PLUGIN_ID}] invalid routing configuration: ${error.message}; routing filter is not active`);
    } else {
      throw error;
    }
  }
  if (routing) logger.info(`[${PLUGIN_ID}] routing filter active for ${routing.providerCount} provider(s)`);

  let refreshing = false;
  const ensureStats = (): void => {
    if (!routing || refreshing) return;
    refreshing = true;
    void (async () => {
      try {
        let gained = false;
        while (routing && routing.pendingCount() > 0) {
          gained = (await routing.refresh()) || gained;
        }
        if (gained) await context.model.reload?.();
      } catch (error) {
        logger.warn(`[${PLUGIN_ID}] stats refresh failed: ${String(error)}`);
      } finally {
        refreshing = false;
      }
      // Models that landed while fetching enqueue fresh pending work.
      if (routing && routing.pendingCount() > 0) ensureStats();
    })();
  };

  let lastRun: FilterRun | undefined;
  void context.model.transform((editor) => {
    if (config.disabled) return;
    try {
      const run = applyToEditor(config, editor, routing
        ? (providerID, model) => routing.verdictFor(providerID, model)
        : undefined);
      lastRun = run;
      for (const warning of run.warnings) logger.warn(`[${PLUGIN_ID}] ${warning}`);
      logger.info(
        run.removedCount > 0
          ? `[${PLUGIN_ID}] filtered ${run.removedCount} model(s) from ${run.removals.size} provider(s)`
          : `[${PLUGIN_ID}] active; nothing was filtered (a no-op rule is usually a typo)`,
      );
      ensureStats();
    } catch (error) {
      logger.warn(`[${PLUGIN_ID}] failed to apply filtering: ${String(error)}`);
    }
  });

  void context.command.transform((commands) => {
    commands.add({
      name: "openrouter-filter",
      description: "Show what the OpenRouter model filter removed and why",
      // The host's Command.Definition requires a template; this command never
      // sends a prompt, so an inert placeholder is used.
      template: "",
      execute: async () => {
        if (config.disabled) {
          logger.info(`[${PLUGIN_ID}] disabled by configuration`);
          return;
        }
        if (!lastRun) {
          logger.info(`[${PLUGIN_ID}] no catalog has been assembled yet`);
          return;
        }
        for (const [providerID, modelIDs] of lastRun.removals) {
          logger.info(`[${PLUGIN_ID}] ${providerID}: hidden ${modelIDs.length} model(s)`);
        }
        if (routing) {
          logger.info(
            `[${PLUGIN_ID}] routing filter active for ${routing.providerCount} provider(s)` +
              (routing.pendingCount() > 0 ? ` (${routing.pendingCount()} model(s) awaiting stats)` : ""),
          );
        }
        for (const warning of lastRun.warnings) logger.warn(`[${PLUGIN_ID}] ${warning}`);
        if (lastRun.removedCount === 0 && lastRun.warnings.length === 0) {
          logger.info(`[${PLUGIN_ID}] active; nothing was filtered`);
        }
      },
    });
  });

  return { config, lastRun: () => lastRun };
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: (context) => {
    setupPlugin(context as unknown as SetupContext);
  },
});
