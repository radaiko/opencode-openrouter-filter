import { globMatch, matchAny } from "./pattern.js";
import { presets, type FilterableModel, type PresetName } from "./presets.js";
import type { ValidatedConfig, ValidatedRule } from "./config.js";

export interface ProviderCatalog {
  readonly providerID: string;
  readonly models: readonly FilterableModel[];
}

export interface DefaultModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

export interface ApplyInput {
  readonly listProviders: () => readonly ProviderCatalog[];
  readonly getDefault: () => DefaultModelRef | undefined;
  /**
   * Routing verdict from the provider-settings filter: a reason string hides
   * the model, undefined keeps it. Applied after the rule chain, so a model
   * must pass both.
   */
  readonly routingFor?: (providerID: string, model: FilterableModel) => string | undefined;
}

export interface FilterRun {
  /** providerID -> model ids to remove, in catalog order. */
  readonly removals: ReadonlyMap<string, readonly string[]>;
  readonly removedCount: number;
  readonly warnings: readonly string[];
}

/** The user config merged over the provider's defaults block. */
export function mergeRule(defaults: ValidatedRule | undefined, rule: ValidatedRule): ValidatedRule {
  if (!defaults) return rule;
  return {
    provider: rule.provider,
    include: [...defaults.include, ...rule.include],
    exclude: [...defaults.exclude, ...rule.exclude],
    presets: [...new Set([...defaults.presets, ...rule.presets])] as PresetName[],
    allowEmpty: rule.allowEmpty,
    protectDefault: rule.protectDefault,
  };
}

function decides(
  model: FilterableModel,
  rule: ValidatedRule,
  warn: (message: string) => void,
  providerID: string,
): boolean {
  // A model another transform already hid needs no work from us.
  if (model.enabled === false) return true;
  // Every gate is an allowlist; exclude always wins.
  if (rule.exclude.length > 0 && matchAny(rule.exclude, model.id)) return false;
  if (rule.include.length > 0 && !matchAny(rule.include, model.id)) return false;
  for (const preset of rule.presets) {
    const predicate = presets[preset];
    if (!predicate) {
      warn(`rule for provider "${providerID}": preset "${preset}" is unknown and was skipped`);
      continue;
    }
    if (!predicate(model)) return false;
  }
  return true;
}

/**
 * Decide which models the config removes, without touching a catalog.
 *
 * Safety rules, in order per matched provider:
 * 1. The catalog default model is kept visible unless the rule sets
 *    protectDefault: false (a hidden default would break new sessions).
 * 2. A rule that would remove every model of a provider is skipped unless it
 *    sets allowEmpty: true (the usual cause is a typo in a pattern).
 * 3. Include patterns that match nothing in the matched providers, and
 *    provider globs that match no provider, are reported as warnings — they
 *    are almost always typos in a long-running config.
 */
export function applyFilter(config: ValidatedConfig, input: ApplyInput): FilterRun {
  const warnings: string[] = [];
  const removals = new Map<string, string[]>();
  if (config.disabled) return { removals, removedCount: 0, warnings };

  const providers = input.listProviders();
  const defaultRef = input.getDefault();
  const matchedProviders = new Set<string>();
  const includeUsage = new Map<string, number>();
  for (const rule of [...(config.defaults ? [config.defaults] : []), ...config.rules]) {
    for (const pattern of rule.include) includeUsage.set(pattern, 0);
  }

  const consider = (rule: ValidatedRule) => {
    let matchedAny = false;
    for (const catalog of providers) {
      if (!globMatch(rule.provider, catalog.providerID)) continue;
      matchedAny = true;
      matchedProviders.add(catalog.providerID);
      const remove: string[] = [];
      for (const model of catalog.models) {
        const isDefault =
          defaultRef !== undefined &&
          defaultRef.providerID === catalog.providerID &&
          defaultRef.modelID === model.id;
        const kept = decides(model, rule, (message) => warnings.push(message), catalog.providerID);
        if (!kept && !(isDefault && rule.protectDefault)) remove.push(model.id);
        if (kept && rule.include.length > 0) {
          for (const pattern of rule.include) {
            if (globMatch(pattern, model.id)) includeUsage.set(pattern, (includeUsage.get(pattern) ?? 0) + 1);
          }
        }
      }
      const keptCount = catalog.models.length - remove.length;
      if (keptCount === 0 && catalog.models.length > 0 && !rule.allowEmpty) {
        warnings.push(
          `rule for provider "${catalog.providerID}" would remove all ${catalog.models.length} models; ` +
            "nothing was removed (set allowEmpty: true to allow this)",
        );
        continue;
      }
      if (remove.length > 0) {
        const existing = removals.get(catalog.providerID);
        if (existing) {
          const merged = new Set([...existing, ...remove]);
          removals.set(catalog.providerID, [...merged]);
        } else {
          removals.set(catalog.providerID, [...remove]);
        }
      }
    }
    if (!matchedAny) {
      warnings.push(`rule provider pattern "${rule.provider}" matches no provider; nothing was filtered`);
    }
  };

  if (config.defaults) consider(config.defaults);
  for (const rule of config.rules) consider(rule);

  // Routing (provider-settings) pass: independent of the rules, so a provider
  // with routing cutoffs but no filter rule still gets filtered. Same safety
  // rails: never hide the catalog default, never empty a provider outright.
  if (input.routingFor) {
    for (const catalog of providers) {
      const already = removals.get(catalog.providerID) ?? [];
      const gone = new Set(already);
      const remove: string[] = [];
      let keptDefault = false;
      for (const model of catalog.models) {
        if (model.enabled === false || gone.has(model.id)) continue;
        const reason = input.routingFor(catalog.providerID, model);
        if (!reason) continue;
        const isDefault =
          defaultRef !== undefined &&
          defaultRef.providerID === catalog.providerID &&
          defaultRef.modelID === model.id;
        if (isDefault) {
          keptDefault = true;
          continue;
        }
        gone.add(model.id);
        remove.push(model.id);
      }
      if (remove.length > 0 && gone.size >= catalog.models.length && !keptDefault) {
        warnings.push(
          `routing settings for provider "${catalog.providerID}" would remove all ` +
            `${catalog.models.length} models; nothing was removed by routing`,
        );
        continue;
      }
      if (keptDefault && remove.length + already.length + 1 >= catalog.models.length) {
        warnings.push(
          `routing settings for provider "${catalog.providerID}" left only the default model visible`,
        );
      }
      if (remove.length > 0) {
        removals.set(catalog.providerID, [...new Set([...already, ...remove])]);
      }
    }
  }

  for (const [pattern, used] of includeUsage) {
    if (used === 0) {
      warnings.push(`include pattern "${pattern}" matches no model; check the spelling`);
    }
  }

  let removedCount = 0;
  for (const ids of removals.values()) removedCount += ids.length;
  return { removals, removedCount, warnings };
}
