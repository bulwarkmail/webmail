import { describe, expect, it } from 'vitest';
import { MAX_SEEN_BYTES, decodeSeen, encodeSeen, isUnseen, markThreadSeen, type SeenMap } from '../seen';

const MIN = 60_000;
const at = (minute: number) => minute * MIN;

describe('team notes seen per user', () => {
  it('round-trips through the stored form at minute precision', () => {
    const map: SeenMap = { g: { baseline: at(1000), threads: { t1: at(2000), t2: at(1500) } } };
    expect(decodeSeen(JSON.parse(JSON.stringify(encodeSeen(map))))).toEqual(map);
  });

  it('never stores threads the baseline already covers', () => {
    const value = encodeSeen({ g: { baseline: at(1000), threads: { old: at(999), same: at(1000), newer: at(1001) } } });
    expect(Object.keys(value.a.g.s)).toEqual(['newer']);
  });

  it('stays under the size limit, dropping the threads seen longest ago', () => {
    const threads: Record<string, number> = {};
    for (let i = 0; i < 1000; i += 1) threads[`thread-${i}`] = at(10_000 + i);
    const value = encodeSeen({ g: { baseline: at(1), threads } });
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(MAX_SEEN_BYTES);
    const kept = Object.keys(value.a.g.s);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept).toContain('thread-999');
    expect(kept).not.toContain('thread-0');
  });

  it('drops malformed stored values instead of failing', () => {
    expect(decodeSeen(null)).toEqual({});
    expect(decodeSeen({ v: 2, a: {} })).toEqual({});
    expect(decodeSeen({ v: 1, a: { g: { b: 'zz!', s: {} }, h: { b: '1', s: { t: 'nope!', u: '2' } } } }))
      .toEqual({ h: { baseline: at(1), threads: { u: at(2) } } });
  });

  it('says a note is new after the last time the conversation was seen, and only then', () => {
    let map: SeenMap = { g: { baseline: at(100), threads: {} } };
    expect(isUnseen(map.g, 't', at(99))).toBe(false);
    expect(isUnseen(map.g, 't', at(101))).toBe(true);
    map = markThreadSeen(map, 'g', 't', at(101));
    expect(isUnseen(map.g, 't', at(101))).toBe(false);
    expect(isUnseen(map.g, 't', at(102))).toBe(true);
    // Never backwards.
    expect(markThreadSeen(map, 'g', 't', at(50))).toBe(map);
    expect(isUnseen(undefined, 't', at(500))).toBe(false);
  });
});
