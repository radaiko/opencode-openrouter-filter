/**
 * Glob matching for model ids and provider ids.
 *
 * `*` matches any run of characters, `?` matches exactly one. Everything else
 * is literal. Anchored at both ends, so a pattern either names the id or does
 * not — no accidental substring matches.
 */

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Compile a glob to an anchored RegExp. Returns null for an invalid pattern. */
export function compileGlob(pattern: string): RegExp | null {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegExp(char);
  }
  source += "$";
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/** True when `value` matches the glob `pattern`; an invalid pattern matches nothing. */
export function globMatch(pattern: string, value: string): boolean {
  const re = compileGlob(pattern);
  return re !== null && re.test(value);
}

/** True when any pattern matches `value`. */
export function matchAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, value));
}
