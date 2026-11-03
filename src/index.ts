import { Plugin } from "@opencode/plugin";

import { applyToEditor, type CatalogEditor } from "./adapter.js";
import { ConfigError, loadConfig, type ValidatedConfig } from "./config.js";
import type { FilterRun } from "./filter.js";

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
  };
  readonly command: {
    readonly transform: (callback: (editor: { add(definition: unknown): void }) => void) => Promise<unknown>;
  };
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

  let lastRun: FilterRun | undefined;
  void context.model.transform((editor) => {
    if (config.disabled) return;
    try {
      const run = applyToEditor(config, editor);
      lastRun = run;
      for (const warning of run.warnings) logger.warn(`[${PLUGIN_ID}] ${warning}`);
      logger.info(
        run.removedCount > 0
          ? `[${PLUGIN_ID}] filtered ${run.removedCount} model(s) from ${run.removals.size} provider(s)`
          : `[${PLUGIN_ID}] active; nothing was filtered (a no-op rule is usually a typo)`,
      );
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
