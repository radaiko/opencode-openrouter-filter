import { PRESET_NAMES, type PresetName } from "./presets.js";

/** User-facing configuration, exactly as it appears in the plugin options. */
export interface FilterRule {
  /** Glob matched against provider ids (e.g. "openrouter", "litellm/*"). Required. */
  provider?: unknown;
  /** Keep only model ids matching at least one of these globs. */
  include?: unknown;
  /** Drop model ids matching any of these globs. Wins over include. */
  exclude?: unknown;
  /** Named capability predicates; every preset must pass. */
  presets?: unknown;
  /** Hide models whose catalog release date is older than this many days. */
  maxAgeDays?: unknown;
  /** Allow this rule to remove every model of the provider. Default false. */
  allowEmpty?: unknown;
  /** Keep the catalog default model visible even if the rule would drop it. Default true. */
  protectDefault?: unknown;
}

export interface FilterConfig {
  disabled?: boolean;
  defaults?: FilterRule;
  rules?: FilterRule[];
  /** Provider-settings (OpenRouter routing) filter; see routing.ts. */
  routing?: unknown;
}

export interface ValidatedRule {
  readonly provider: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly presets: readonly PresetName[];
  readonly allowEmpty: boolean;
  readonly protectDefault: boolean;
  readonly maxAgeDays: number | undefined;
}

export interface ValidatedConfig {
  readonly disabled: boolean;
  readonly defaults: ValidatedRule | undefined;
  readonly rules: readonly ValidatedRule[];
  readonly warnings: readonly string[];
}

export class ConfigError extends Error {}

function asStringArray(value: unknown, where: string, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  const kept: string[] = [];
  for (const entry of value as string[]) {
    if (entry.trim() === "") {
      warnings.push(`${where}: skipped an empty pattern`);
      continue;
    }
    kept.push(entry.trim());
  }
  return kept;
}

function asPresets(value: unknown, where: string, warnings: string[]): PresetName[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where} must be an array of preset names`);
  }
  const kept: PresetName[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && (PRESET_NAMES as readonly string[]).includes(entry)) {
      kept.push(entry as PresetName);
    } else {
      warnings.push(`${where}: unknown preset "${String(entry)}" was skipped`);
    }
  }
  return kept;
}

function asBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be a boolean`);
  return value;
}

function asPositiveNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${where} must be a positive number`);
  }
  return value;
}

function validateRule(
  rule: FilterRule,
  where: string,
  warnings: string[],
  providerOptional = false,
): ValidatedRule {
  if (rule.provider === undefined && providerOptional) {
    rule = { ...rule, provider: "*" };
  }
  if (typeof rule.provider !== "string" || rule.provider.trim() === "") {
    throw new ConfigError(`${where}: "provider" is required and must be a non-empty string`);
  }
  return {
    provider: rule.provider.trim(),
    include: asStringArray(rule.include, `${where}.include`, warnings) ?? [],
    exclude: asStringArray(rule.exclude, `${where}.exclude`, warnings) ?? [],
    presets: asPresets(rule.presets, `${where}.presets`, warnings) ?? [],
    allowEmpty: asBoolean(rule.allowEmpty, `${where}.allowEmpty`, false),
    protectDefault: asBoolean(rule.protectDefault, `${where}.protectDefault`, true),
    maxAgeDays: asPositiveNumber(rule.maxAgeDays, `${where}.maxAgeDays`),
  };
}

function isRuleLike(value: unknown): value is FilterRule {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate raw plugin options. Throws ConfigError on anything that cannot be
 * honoured; collects warnings for parts that can be honoured with a downgrade.
 */
export function loadConfig(options: unknown): ValidatedConfig {
  if (options === undefined || options === null) {
    return { disabled: false, defaults: undefined, rules: [], warnings: [] };
  }
  if (!isRuleLike(options)) {
    throw new ConfigError("options must be an object with optional disabled, defaults and rules");
  }
  const config = options as FilterConfig;
  const warnings: string[] = [];
  const disabled = asBoolean(config.disabled, "disabled", false);

  const rawRules = config.rules ?? [];
  if (!Array.isArray(rawRules)) throw new ConfigError("rules must be an array");
  const rules = rawRules.map((rule, i) => validateRule(rule ?? {}, `rules[${i}]`, warnings));

  const defaults =
    config.defaults === undefined
      ? undefined
      : validateRule(config.defaults, "defaults", warnings, true);
  return { disabled, defaults, rules, warnings };
}
