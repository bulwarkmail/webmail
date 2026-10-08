import type { FilterRule } from '@/lib/jmap/sieve-types';

/**
 * Time periods for filter rules: "only act on mail that arrives from ...
 * until ...". Sieve has no rule scheduling of its own; the date extension
 * (RFC 5260) lets a rule test the moment the message is being filtered.
 */

/** Sieve extensions a period needs: `currentdate` and `:value` comparisons. */
export const PERIOD_REQUIRES = ['date', 'relational'] as const;

export function supportsPeriods(extensions: readonly string[] | undefined | null): boolean {
  return PERIOD_REQUIRES.every((e) => extensions?.includes(e));
}

// A moment with its zone spelled out. Without one, Date.parse reads the value
// as local time, which would make the script depend on the browser saving it.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether `value` is a usable period boundary (see FilterRule.activeFrom). */
export function isPeriodBoundary(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return false;
  const time = Date.parse(value);
  // In UTC the zone can push it past year 9999 ("9999-12-31T23:59-01:00"),
  // which the four-digit year of Sieve's "date" part cannot hold.
  return !Number.isNaN(time) && /^\d{4}-/.test(new Date(time).toISOString());
}

export function hasPeriod(rule: Pick<FilterRule, 'activeFrom' | 'activeUntil'>): boolean {
  return rule.activeFrom !== undefined || rule.activeUntil !== undefined;
}

/**
 * The boundary as RFC 5260 "date" (yyyy-mm-dd) and "time" (hh:mm:ss) parts in
 * UTC. The RFC fixes both formats, so comparing them as strings works on any
 * server - unlike "iso8601", whose zone suffix is up to the implementation.
 */
function utcParts(boundary: string): { date: string; time: string } {
  const iso = new Date(Date.parse(boundary)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

const NOW = 'currentdate :zone "+0000"';

/** now >= boundary: a later day, or the same day at or after the time. */
function atOrAfter(boundary: string): string {
  const { date, time } = utcParts(boundary);
  return `anyof(${NOW} :value "gt" "date" "${date}", allof(${NOW} :is "date" "${date}", ${NOW} :value "ge" "time" "${time}"))`;
}

/** now <= boundary: an earlier day, or the same day at or before the time. */
function atOrBefore(boundary: string): string {
  const { date, time } = utcParts(boundary);
  return `anyof(${NOW} :value "lt" "date" "${date}", allof(${NOW} :is "date" "${date}", ${NOW} :value "le" "time" "${time}"))`;
}

/**
 * The Sieve tests that confine `rule` to its period: none without a period,
 * null when a boundary is unusable. A caller must then drop the rule rather
 * than run it without its period - a forwarding rule would otherwise forward
 * for good.
 */
export function periodTests(rule: Pick<FilterRule, 'activeFrom' | 'activeUntil'>): string[] | null {
  const tests: string[] = [];
  if (rule.activeFrom !== undefined) {
    if (!isPeriodBoundary(rule.activeFrom)) return null;
    tests.push(atOrAfter(rule.activeFrom));
  }
  if (rule.activeUntil !== undefined) {
    if (!isPeriodBoundary(rule.activeUntil)) return null;
    tests.push(atOrBefore(rule.activeUntil));
  }
  return tests;
}

export type PeriodStatus = 'scheduled' | 'active' | 'expired';

/** Where `now` falls in the rule's period; null for a rule without one. */
export function periodStatus(
  rule: Pick<FilterRule, 'activeFrom' | 'activeUntil'>,
  now: number = Date.now(),
): PeriodStatus | null {
  if (!hasPeriod(rule)) return null;
  if (isPeriodBoundary(rule.activeFrom) && now < Date.parse(rule.activeFrom)) return 'scheduled';
  if (isPeriodBoundary(rule.activeUntil) && now > Date.parse(rule.activeUntil)) return 'expired';
  return 'active';
}
