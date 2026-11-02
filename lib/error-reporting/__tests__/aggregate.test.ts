// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bound, KEEP_DAYS, MAX_PER_DAY, merge, summarizeDay, type Aggregate, type AggregateEntry } from '../aggregate';

function entry(count: number): AggregateEntry {
  return { name: 'Error', frames: [], version: '1.20.0', runtime: 'browser', count };
}

describe('error aggregate', () => {
  it('adds counts from several replicas instead of overwriting them', () => {
    const a: Aggregate = { '2026-11-01': { f1: entry(2) } };
    const b: Aggregate = { '2026-11-01': { f1: entry(3), f2: entry(1) } };
    expect(merge(a, b)['2026-11-01']).toEqual({ f1: entry(5), f2: entry(1) });
  });

  it('keeps the most frequent fingerprints per day and only the last days', () => {
    const many: Record<string, AggregateEntry> = {};
    for (let i = 0; i < MAX_PER_DAY + 50; i++) many[`f${i}`] = entry(i + 1);
    const old = '2026-10-01';
    const bounded = bound({ '2026-11-01': many, [old]: { x: entry(1) } }, '2026-11-01');
    expect(Object.keys(bounded['2026-11-01'])).toHaveLength(MAX_PER_DAY);
    expect(bounded['2026-11-01'].f0).toBeUndefined();
    expect(bounded['2026-11-01'][`f${MAX_PER_DAY + 49}`]).toBeDefined();
    expect(bounded[old]).toBeUndefined();
    const lastKept = new Date(Date.parse('2026-11-01T00:00:00Z') - (KEEP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    expect(Object.keys(bound({ [lastKept]: { x: entry(1) } }, '2026-11-01'))).toEqual([lastKept]);
  });

  it('summarizes a day, most frequent first', () => {
    const summary = summarizeDay({ '2026-11-01': { a: entry(1), b: entry(5) } }, '2026-11-01');
    expect(summary.total).toBe(6);
    expect(summary.top.map((e) => e.fingerprint)).toEqual(['b', 'a']);
  });
});
