import { describe, expect, it } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { isPeriodBoundary, periodStatus, periodTests, supportsPeriods } from '../period';

/**
 * Evaluates the Sieve tests periodTests() writes, following RFC 5260: in zone
 * "+0000" the "date" part is yyyy-mm-dd and "time" is hh:mm:ss, and :value
 * compares them as strings (the default comparator). It reads only that
 * subset, so it checks the logic, not a server's parser - the scripts were
 * also run through Stalwart's own interpreter (sieve-rs) by hand.
 */
function evaluate(test: string, now: Date): boolean {
  const split = (inner: string) => {
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === '(') depth++;
      else if (!quoted && ch === ')') depth--;
      else if (!quoted && depth === 0 && ch === ',') {
        parts.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(inner.slice(start).trim());
    return parts;
  };
  const group = test.match(/^(anyof|allof)\((.*)\)$/);
  if (group) {
    const results = split(group[2]).map((t) => evaluate(t, now));
    return group[1] === 'anyof' ? results.some(Boolean) : results.every(Boolean);
  }
  const current = test.match(/^currentdate :zone "\+0000" (?::is|:value "(gt|ge|lt|le)") "(date|time)" "([^"]+)"$/);
  if (!current) throw new Error(`not a period test: ${test}`);
  const [, op, part, key] = current;
  const iso = now.toISOString();
  const value = part === 'date' ? iso.slice(0, 10) : iso.slice(11, 19);
  switch (op) {
    case undefined: return value === key;
    case 'gt': return value > key;
    case 'ge': return value >= key;
    case 'lt': return value < key;
    default: return value <= key;
  }
}

const inPeriod = (period: Pick<FilterRule, 'activeFrom' | 'activeUntil'>, at: string) =>
  periodTests(period)!.every((t) => evaluate(t, new Date(at)));

describe('period boundaries', () => {
  it('accepts ISO moments with a zone only', () => {
    expect(isPeriodBoundary('2026-10-05T06:00:00.000Z')).toBe(true);
    expect(isPeriodBoundary('2026-10-05T08:00+02:00')).toBe(true);
    // Without a zone, Date.parse would read local time: browser-dependent.
    expect(isPeriodBoundary('2026-10-05T08:00')).toBe(false);
    expect(isPeriodBoundary('2026-10-05')).toBe(false);
    expect(isPeriodBoundary('2026-13-45T08:00:00Z')).toBe(false);
    expect(isPeriodBoundary('')).toBe(false);
    expect(isPeriodBoundary(null)).toBe(false);
    expect(isPeriodBoundary(1_790_000_000_000)).toBe(false);
  });

  it('refuses a moment whose year in UTC has no room in four digits', () => {
    // Year 10000 in UTC: Sieve's "date" part would read "+010000-01-01".
    expect(isPeriodBoundary('9999-12-31T23:59:59-01:00')).toBe(false);
    expect(isPeriodBoundary('+010000-01-01T00:59:59.000Z')).toBe(false);
    expect(isPeriodBoundary('9999-12-31T23:59:59Z')).toBe(true);
  });

  it('needs the date and relational extensions', () => {
    expect(supportsPeriods(['fileinto', 'date', 'relational'])).toBe(true);
    expect(supportsPeriods(['fileinto', 'date'])).toBe(false);
    expect(supportsPeriods(undefined)).toBe(false);
  });

  it('gives no tests without a period and null for an unusable boundary', () => {
    expect(periodTests({})).toEqual([]);
    expect(periodTests({ activeFrom: '2026-10-05T08:00' })).toBeNull();
    expect(periodTests({ activeFrom: '2026-10-05T06:00:00Z', activeUntil: 'soon' })).toBeNull();
  });

  it('writes the start and end as UTC date and time tests', () => {
    expect(periodTests({ activeFrom: '2026-10-05T08:00:00+02:00', activeUntil: '2026-10-16T16:00:00.000Z' })).toEqual([
      'anyof(currentdate :zone "+0000" :value "gt" "date" "2026-10-05", allof(currentdate :zone "+0000" :is "date" "2026-10-05", currentdate :zone "+0000" :value "ge" "time" "06:00:00"))',
      'anyof(currentdate :zone "+0000" :value "lt" "date" "2026-10-16", allof(currentdate :zone "+0000" :is "date" "2026-10-16", currentdate :zone "+0000" :value "le" "time" "16:00:00"))',
    ]);
  });
});

describe('period logic (RFC 5260 semantics)', () => {
  const period = { activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' };

  it.each([
    ['one second before the start', '2026-10-05T05:59:59Z', false],
    ['the day before, later than the start time', '2026-10-04T23:00:00Z', false],
    ['the start', '2026-10-05T06:00:00Z', true],
    ['later on the first day', '2026-10-05T23:59:59Z', true],
    ['the next day, earlier than the start time', '2026-10-06T00:00:00Z', true],
    ['the middle', '2026-10-10T12:00:00Z', true],
    ['the last day, earlier than the end time', '2026-10-16T05:00:00Z', true],
    ['the end', '2026-10-16T16:00:00Z', true],
    ['one second after the end', '2026-10-16T16:00:01Z', false],
    ['the day after, earlier than the end time', '2026-10-17T00:00:00Z', false],
  ])('%s: %s -> %s', (_label, at, expected) => {
    expect(inPeriod(period, at)).toBe(expected);
  });

  it('leaves either end open', () => {
    expect(inPeriod({ activeFrom: period.activeFrom }, '2099-01-01T00:00:00Z')).toBe(true);
    expect(inPeriod({ activeFrom: period.activeFrom }, '2026-10-05T05:59:59Z')).toBe(false);
    expect(inPeriod({ activeUntil: period.activeUntil }, '2000-01-01T00:00:00Z')).toBe(true);
    expect(inPeriod({ activeUntil: period.activeUntil }, '2026-10-16T16:00:01Z')).toBe(false);
  });

  it('spans a new year', () => {
    const newYear = { activeFrom: '2026-12-31T23:30:00Z', activeUntil: '2027-01-01T00:30:00Z' };
    expect(inPeriod(newYear, '2026-12-31T23:29:59Z')).toBe(false);
    expect(inPeriod(newYear, '2026-12-31T23:30:00Z')).toBe(true);
    expect(inPeriod(newYear, '2027-01-01T00:00:00Z')).toBe(true);
    expect(inPeriod(newYear, '2027-01-01T00:30:00Z')).toBe(true);
    expect(inPeriod(newYear, '2027-01-01T00:30:01Z')).toBe(false);
  });

  it('spans the switch from summer to winter time (Berlin, 25 Oct 2026)', () => {
    // 24 Oct 22:00 CEST until 26 Oct 08:00 CET, written with their offsets.
    const overSwitch = { activeFrom: '2026-10-24T22:00:00+02:00', activeUntil: '2026-10-26T08:00:00+01:00' };
    expect(inPeriod(overSwitch, '2026-10-24T19:59:59Z')).toBe(false);
    expect(inPeriod(overSwitch, '2026-10-24T20:00:00Z')).toBe(true);
    expect(inPeriod(overSwitch, '2026-10-25T01:30:00Z')).toBe(true);
    expect(inPeriod(overSwitch, '2026-10-26T07:00:00Z')).toBe(true);
    expect(inPeriod(overSwitch, '2026-10-26T07:00:01Z')).toBe(false);
  });

  it('never acts when the period ends before it starts', () => {
    const inverted = { activeFrom: '2026-10-16T00:00:00Z', activeUntil: '2026-10-05T00:00:00Z' };
    for (const at of ['2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z', '2026-10-20T00:00:00Z']) {
      expect(inPeriod(inverted, at)).toBe(false);
    }
  });

  it('reports where a moment falls', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(periodStatus({}, now)).toBeNull();
    expect(periodStatus(period, now)).toBe('active');
    expect(periodStatus({ activeFrom: '2026-10-11T00:00:00Z' }, now)).toBe('scheduled');
    expect(periodStatus({ activeUntil: '2026-10-09T00:00:00Z' }, now)).toBe('expired');
  });
});

const rule = (extra: Partial<FilterRule> = {}): FilterRule => ({
  id: 'r1',
  name: 'Urlaub',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: '@' }],
  actions: [{ type: 'forward', value: 'kollege@example.com' }, { type: 'discard' }],
  stopProcessing: false,
  ...extra,
});

const PERIOD = { activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' };
const EXTENSIONS = ['fileinto', 'mailbox', 'mailboxid', 'spamtestplus', 'relational', 'comparator-i;ascii-numeric', 'date', 'copy'];

describe('generator with periods', () => {
  it('confines the rule to its period and requires date and relational', () => {
    const script = generateScript([rule(PERIOD)], undefined, { extensions: EXTENSIONS });
    const [from, until] = periodTests(PERIOD)!;
    expect(script).toContain('require ["date", "relational"];');
    expect(script).toContain(`if allof(${from}, ${until}, header :contains "From" "@") {`);
    expect(script).toContain('    redirect "kollege@example.com";');
  });

  it('keeps the conditions and the spam guard intact inside the period', () => {
    const any = generateScript([rule({
      ...PERIOD,
      matchType: 'any',
      conditions: [
        { field: 'from', comparator: 'contains', value: 'a' },
        { field: 'subject', comparator: 'contains', value: ['b', 'c'] },
      ],
      actions: [{ type: 'move', value: 'F', mailboxId: 'mb' }],
    })], undefined, { extensions: EXTENSIONS });
    const [from, until] = periodTests(PERIOD)!;
    expect(any).toContain(`if allof(${from}, ${until}, allof(anyof(header :contains "From" "a", header :contains "Subject" ["b", "c"]), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50")) {`);
    expect(any).toContain('require ["comparator-i;ascii-numeric", "date", "fileinto", "mailbox", "mailboxid", "relational", "spamtestplus"];');
  });

  it('writes an open-ended period as one test', () => {
    const script = generateScript([rule({ activeUntil: PERIOD.activeUntil })]);
    const [until] = periodTests({ activeUntil: PERIOD.activeUntil })!;
    expect(script).toContain(`if allof(${until}, header :contains "From" "@") {`);
  });

  it('drops a rule whose period is unusable instead of running it for good', () => {
    const script = generateScript([
      rule({ activeUntil: '2026-10-16T16:00' }),
      rule({ id: 'r2', name: 'Other', actions: [{ type: 'star' }] }),
    ]);
    expect(script).not.toContain('redirect');
    expect(script).toContain('# Rule: Other');
    expect(script).not.toContain('"date"');
  });

  it('adds no requirement for a disabled rule with a period', () => {
    const script = generateScript([rule({ ...PERIOD, enabled: false })]);
    expect(script).not.toContain('require');
    expect(script).not.toContain('currentdate');
  });

  it('stores the period in the metadata and reads it back unchanged', () => {
    const rules = [rule(PERIOD), rule({ id: 'r2', name: 'Open', activeFrom: PERIOD.activeFrom })];
    const script = generateScript(rules, undefined, { extensions: EXTENSIONS });
    const parsed = parseScript(script);
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules).toEqual(rules);
    // Writing the rules read back gives the same script, byte for byte.
    expect(generateScript(parsed.rules, undefined, { extensions: EXTENSIONS })).toBe(script);
  });
});

describe('parser with periods', () => {
  const withMetadata = (r: Record<string, unknown>) =>
    `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [r] })}\n@metadata:end */\n`;

  it('leaves a script with an unreadable period alone (treated as hand-edited)', () => {
    for (const activeUntil of ['2026-10-16T16:00', '', null, 42]) {
      const parsed = parseScript(withMetadata({ ...rule(), activeUntil }));
      expect(parsed.isOpaque).toBe(true);
    }
  });

  it('reads rules without a period as before', () => {
    const parsed = parseScript(withMetadata({ ...rule() }));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules[0]).not.toHaveProperty('activeFrom');
  });
});
