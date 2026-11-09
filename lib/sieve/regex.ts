import type { FilterCondition, FilterConditionField } from '@/lib/jmap/sieve-types';

/**
 * Regular expression conditions: Sieve `:regex` from the "regex" extension
 * (draft-ietf-sieve-regex). Stalwart lists it in the account's
 * sieveExtensions and compiles the expression when the script is saved, so
 * one broken expression makes the server refuse the whole script.
 */

/** Fields the generator writes `:regex` for: header tests and `body`. */
export const REGEX_FIELDS: ReadonlySet<FilterConditionField> = new Set([
  'from', 'to', 'cc', 'subject', 'header', 'body',
]);

export function supportsRegex(extensions: readonly string[] | undefined | null): boolean {
  return !!extensions?.includes('regex');
}

export function usesRegex(condition: Pick<FilterCondition, 'field' | 'comparator'>): boolean {
  return condition.comparator === 'regex' && REGEX_FIELDS.has(condition.field);
}

/**
 * Whether `pattern` is likely to compile on the server. Stalwart uses Rust
 * regex syntax, so its inline flags ("(?i)", "(?s:...)") and "(?P<name>"
 * groups are rewritten into something JavaScript parses before the check.
 * JavaScript accepts a few things Rust does not; the server still has the
 * last word on those.
 */
export function isValidSieveRegex(pattern: string): boolean {
  if (!pattern) return false;
  const js = pattern
    .replace(/\(\?[a-zA-Z]+\)/g, '')
    .replace(/\(\?[a-zA-Z-]+:/g, '(?:')
    .replace(/\(\?P</g, '(?<');
  try {
    new RegExp(js);
    return true;
  } catch {
    return false;
  }
}
