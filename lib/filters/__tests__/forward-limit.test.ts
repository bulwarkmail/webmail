import { describe, expect, it } from 'vitest';
import type { FilterAction, FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { forwardsAround, ruleForwards, ruleStops, worstCaseForwards } from '../forward-limit';

const forward: FilterAction = { type: 'forward', value: 'x@example.com' };
const rule = (actions: FilterAction[], stopProcessing = false, enabled = true): FilterRule => ({
  id: `r-${Math.random()}`,
  name: 'R',
  enabled,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'a' }],
  actions,
  stopProcessing,
});

// "Forward to a colleague, delete silently, stop processing", and a rule for
// every other message that forwards too.
const vendor = rule([forward, { type: 'discard' }], true);
const everyoneElse = rule([forward]);

describe('the forwards of one rule', () => {
  it('counts those ahead of a Stop action', () => {
    expect(ruleForwards(rule([forward, forward]))).toBe(2);
    expect(ruleForwards(rule([forward, { type: 'stop' }, forward]))).toBe(1);
    expect(ruleForwards(rule([{ type: 'mark_read' }]))).toBe(0);
  });

  it('knows a rule stops by its checkbox or a Stop action', () => {
    expect(ruleStops(rule([forward], true))).toBe(true);
    expect(ruleStops(rule([forward, { type: 'stop' }]))).toBe(true);
    // Delete silently and Reject alone do not end the script.
    expect(ruleStops(rule([forward, { type: 'discard' }]))).toBe(false);
    expect(ruleStops(rule([{ type: 'reject', value: 'no' }]))).toBe(false);
  });
});

describe('the most forwards one message can collect', () => {
  it('stays at one when a rule that forwards stops ahead of another that forwards', () => {
    expect(worstCaseForwards([vendor, everyoneElse])).toBe(1);
  });

  it('is two once the rule for every message comes first', () => {
    // A message for the colleague meets both: the second forward would be skipped.
    expect(worstCaseForwards([everyoneElse, vendor])).toBe(2);
  });

  it('adds up the rules that let a message go on', () => {
    expect(worstCaseForwards([everyoneElse, rule([forward]), rule([forward])])).toBe(3);
    expect(worstCaseForwards([rule([forward], true), rule([forward, forward], true)])).toBe(2);
  });

  it('leaves out rules that are off', () => {
    expect(worstCaseForwards([rule([forward], false, false), vendor])).toBe(1);
  });

  it('is none without forwards', () => {
    expect(worstCaseForwards([])).toBe(0);
    expect(worstCaseForwards([rule([{ type: 'mark_read' }], true)])).toBe(0);
  });
});

describe('the forwards around one rule', () => {
  it('takes nothing from a rule above that stops, for a new rule below it', () => {
    expect(forwardsAround([vendor], 1, false)).toEqual({ before: 0, after: 0 });
  });

  it('takes the forwards of a rule above that lets messages go on', () => {
    const going = rule([forward, { type: 'discard' }]);
    expect(forwardsAround([going], 1, false)).toEqual({ before: 1, after: 0 });
  });

  it('takes the worst case below an edited rule, without the rule itself', () => {
    expect(forwardsAround([vendor, everyoneElse], 0, true)).toEqual({ before: 0, after: 1 });
    expect(forwardsAround([everyoneElse, vendor], 1, true)).toEqual({ before: 1, after: 0 });
  });

  it('puts a new rule at the index, keeping the rule there below it', () => {
    expect(forwardsAround([everyoneElse, vendor], 1, false)).toEqual({ before: 1, after: 1 });
  });
});

describe('the count and the script', () => {
  it('agree on the forwards a rule runs and whether it stops', () => {
    const variants: FilterAction[][] = [
      [forward],
      [forward, { type: 'discard' }],
      [forward, { type: 'reject', value: 'no' }],
      [forward, { type: 'move', value: 'Archive' }],
      [{ type: 'mark_read' }, forward, forward],
      [forward, { type: 'stop' }, forward],
      [{ type: 'stop' }, forward],
    ];
    for (const actions of variants) {
      for (const stopProcessing of [false, true]) {
        const r = rule(actions, stopProcessing);
        const lines = generateScript([r]).split('# Rule:')[1].split('\n').map((line) => line.trim());
        const stop = lines.indexOf('stop;');
        const runs = stop === -1 ? lines : lines.slice(0, stop);
        const label = `${actions.map((a) => a.type).join(', ')}${stopProcessing ? ', stop processing' : ''}`;
        expect(runs.filter((line) => line.startsWith('redirect ')).length, label).toBe(ruleForwards(r));
        expect(stop !== -1, label).toBe(ruleStops(r));
      }
    }
  });
});

describe('against every set of rules a message can match', () => {
  // A message that matches the rules in `matched`: the forwards it collects,
  // and the rules that run for it.
  function walk(rules: FilterRule[], matched: Set<number>): { forwards: number; ran: Set<number> } {
    let forwards = 0;
    const ran = new Set<number>();
    for (let i = 0; i < rules.length; i++) {
      if (!rules[i].enabled || !matched.has(i)) continue;
      ran.add(i);
      forwards += ruleForwards(rules[i]);
      if (ruleStops(rules[i])) break;
    }
    return { forwards, ran };
  }
  // The most forwards one message can collect; with `runs`, one the rule
  // there runs for.
  function mostCollected(rules: FilterRule[], runs?: number): number {
    let most = 0;
    for (let mask = 0; mask < 1 << rules.length; mask++) {
      const matched = new Set(rules.map((_, i) => i).filter((i) => mask & (1 << i)));
      const { forwards, ran } = walk(rules, matched);
      if (runs === undefined || ran.has(runs)) most = Math.max(most, forwards);
    }
    return most;
  }

  // Fixed seed: the same rule lists on every run.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pool: FilterAction[][] = [
    [], [forward], [forward, forward], [forward, { type: 'discard' }],
    [forward, { type: 'stop' }], [{ type: 'stop' }, forward], [{ type: 'mark_read' }],
  ];
  const lists = Array.from({ length: 300 }, () =>
    Array.from({ length: Math.floor(random() * 7) }, () =>
      rule(pool[Math.floor(random() * pool.length)], random() < 0.4, random() < 0.8)));

  it('finds the most forwards one message can collect', () => {
    for (const rules of lists) expect(worstCaseForwards(rules)).toBe(mostCollected(rules));
  });

  it('finds the most a message the rule runs for can collect, for rules in place and new ones', () => {
    for (const rules of lists) {
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.enabled) continue;
        const { before, after } = forwardsAround(rules, i, true);
        expect(before + ruleForwards(r) + (ruleStops(r) ? 0 : after)).toBe(mostCollected(rules, i));
        // The same rule about to be put there, rather than there already.
        const others = rules.filter((_, j) => j !== i);
        expect(forwardsAround(others, i, false)).toEqual({ before, after });
      }
    }
  });
});
