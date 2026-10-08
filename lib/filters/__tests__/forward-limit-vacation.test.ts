import { describe, expect, it } from 'vitest';
import type { FilterAction, FilterRule, VacationForward } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { VACATION_FORWARD_MARKER } from '@/lib/sieve/vacation-forward';
import { forwardsAround, inRunOrder, ruleForwards, ruleStops, worstCaseForwards } from '../forward-limit';

const forward: FilterAction = { type: 'forward', value: 'office@example.com' };
const rule = (actions: FilterAction[], stopProcessing = false): FilterRule => ({
  id: `r-${Math.random()}`,
  name: 'R',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'a' }],
  actions,
  stopProcessing,
});
const vacationForward = (keepCopy: boolean, enabled = true): VacationForward => ({
  enabled,
  to: 'deputy@example.com',
  keepCopy,
});

describe('the out of office forwarding in the run order', () => {
  const rules = [rule([forward])];

  it('goes ahead of the rules, and stops unless it keeps a copy', () => {
    expect(inRunOrder(rules, vacationForward(true))).toEqual([
      { enabled: true, actions: [{ type: 'forward', value: 'deputy@example.com' }], stopProcessing: false },
      ...rules,
    ]);
    expect(inRunOrder(rules, vacationForward(false))[0].stopProcessing).toBe(true);
  });

  it('is left out while it is off', () => {
    expect(inRunOrder(rules, vacationForward(true, false))).toBe(rules);
    expect(inRunOrder(rules, null)).toBe(rules);
    expect(inRunOrder(rules, undefined)).toBe(rules);
  });

  it('agrees with the script: one redirect ahead of every rule, and a stop unless a copy is kept', () => {
    for (const keepCopy of [true, false]) {
      const script = generateScript(rules, undefined, { vacationForward: vacationForward(keepCopy) });
      expect(script.indexOf(VACATION_FORWARD_MARKER)).toBeGreaterThan(-1);
      expect(script.indexOf(VACATION_FORWARD_MARKER)).toBeLessThan(script.indexOf('# Rule:'));
      const lines = script.split(VACATION_FORWARD_MARKER)[1].split('# Rule:')[0].split('\n').map((line) => line.trim());
      const [ahead] = inRunOrder([], vacationForward(keepCopy));
      expect(lines.filter((line) => line.startsWith('redirect ')).length, `keepCopy ${keepCopy}`).toBe(ruleForwards(ahead));
      expect(lines.includes('stop;'), `keepCopy ${keepCopy}`).toBe(ruleStops(ahead));
    }
  });

  it('adds its forward to every rule only when it keeps a copy', () => {
    // A new rule goes behind Bulwark's rules, here behind the one rule.
    expect(forwardsAround(inRunOrder(rules, vacationForward(true)), 2, false)).toEqual({ before: 2, after: 0 });
    expect(forwardsAround(inRunOrder(rules, vacationForward(false)), 2, false)).toEqual({ before: 1, after: 0 });
    expect(worstCaseForwards(inRunOrder(rules, vacationForward(true)))).toBe(2);
    expect(worstCaseForwards(inRunOrder(rules, vacationForward(false)))).toBe(1);
  });
});
