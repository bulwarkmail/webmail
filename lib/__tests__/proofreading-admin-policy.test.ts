import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { resolvePolicy, type PolicySubject } from '@/lib/admin/policy-scopes';
import { checkerAccess, proofreadingAccess, type PolicyView } from '@/lib/proofreading/gate';
import {
  checkersToForce, pluginProofreadingState, pluginRestrictionFor, proofreadingPolicyFor, proofreadingState,
  type ProofreadingState,
} from '@/lib/admin/proofreading-policy';

// The four admin states as the Organisation > Proofreading page writes
// them, for everyone and for one group, resolved the way the client
// resolves the policy for an account, and what a user then gets.

const SALES: PolicySubject = { email: 'anna@example.org', groups: ['sales@example.org'] };
const OTHER: PolicySubject = { email: 'bob@example.org', groups: [] };

function everyone(state: ProofreadingState): SettingsPolicy {
  const { restriction, preset } = proofreadingPolicyFor(state);
  return {
    ...DEFAULT_POLICY,
    restrictions: restriction ? { proofreading: restriction } : {},
    defaults: { proofreading: preset },
  };
}

function scoped(state: ProofreadingState, base: SettingsPolicy = DEFAULT_POLICY): SettingsPolicy {
  const { restriction, preset } = proofreadingPolicyFor(state);
  return {
    ...base,
    scopes: [{
      id: 'sales', label: 'Sales', match: { groups: ['sales@example.org'] },
      policy: { restrictions: { proofreading: restriction ?? {} }, defaults: { proofreading: preset } },
    }],
  };
}

function viewFor(policy: SettingsPolicy, subject: PolicySubject): PolicyView {
  const resolved = resolvePolicy(policy, subject).policy;
  return { restrictions: resolved.restrictions, defaults: resolved.defaults as Record<string, unknown>, settled: true };
}

/** A user who never touched the setting starts at the policy default. */
const freshUser = (view: PolicyView) => ({ proofreading: view.defaults.proofreading === true, proofreadingPlugins: {} });

describe('the four states for everyone', () => {
  it('off and locked: nothing runs and the setting is hidden, whatever the user stored', () => {
    const view = viewFor(everyone('off-locked'), OTHER);
    expect(proofreadingAccess(view, { proofreading: true, proofreadingPlugins: {} })).toMatchObject({ on: false, lockedOff: true, hidden: true });
    expect(checkerAccess(view, { proofreading: true, proofreadingPlugins: { lt: true } }, 'lt').on).toBe(false);
  });

  it('off by default: off until the user turns it on', () => {
    const view = viewFor(everyone('off'), OTHER);
    expect(proofreadingAccess(view, freshUser(view))).toMatchObject({ on: false, forced: false, lockedOff: false });
    expect(checkerAccess(view, { proofreading: true, proofreadingPlugins: {} }, 'lt').on).toBe(true);
  });

  it('on by default: on until the user turns it off', () => {
    const view = viewFor(everyone('on'), OTHER);
    expect(proofreadingAccess(view, freshUser(view))).toMatchObject({ on: true, forced: false });
    expect(checkerAccess(view, { proofreading: false, proofreadingPlugins: {} }, 'lt').on).toBe(false);
  });

  it('on and locked: on for every checker, also over a stored "off"', () => {
    const view = viewFor(everyone('on-locked'), OTHER);
    expect(proofreadingAccess(view, { proofreading: false, proofreadingPlugins: {} })).toMatchObject({ on: true, forced: true });
    expect(checkerAccess(view, { proofreading: false, proofreadingPlugins: { lt: false } }, 'lt')).toMatchObject({ on: true, forced: true });
  });
});

describe('the four states for one group', () => {
  it('apply to its members and leave everyone else alone', () => {
    for (const state of ['off-locked', 'on', 'on-locked'] as const) {
      const policy = scoped(state);
      const member = viewFor(policy, SALES);
      const other = viewFor(policy, OTHER);
      expect(proofreadingState(member.restrictions.proofreading, member.defaults.proofreading)).toBe(state);
      expect(proofreadingState(other.restrictions.proofreading, other.defaults.proofreading)).toBe('off');
    }
  });

  it('a group can lift a lock everyone has', () => {
    const policy = scoped('on', everyone('off-locked'));
    const member = viewFor(policy, SALES);
    expect(proofreadingAccess(member, freshUser(member))).toMatchObject({ on: true, lockedOff: false });
    expect(proofreadingAccess(viewFor(policy, OTHER), { proofreading: true, proofreadingPlugins: {} })).toMatchObject({ lockedOff: true });
  });

  it('a group can require it while everyone else chooses', () => {
    const policy = scoped('on-locked', everyone('off'));
    expect(checkerAccess(viewFor(policy, SALES), { proofreading: false, proofreadingPlugins: {} }, 'lt').forced).toBe(true);
    expect(checkerAccess(viewFor(policy, OTHER), { proofreading: false, proofreadingPlugins: {} }, 'lt').on).toBe(false);
  });
});

describe('per plugin', () => {
  it('round-trips the plugin states', () => {
    for (const s of ['follow', 'off-locked', 'on-locked'] as const) expect(pluginProofreadingState(pluginRestrictionFor(s))).toBe(s);
  });
});

describe('checkersToForce', () => {
  const lt = { id: 'lt', enabled: true };
  const ai = { id: 'ai', enabled: true };

  it('asks for nothing unless proofreading is required', () => {
    expect(checkersToForce('on', {}, [lt, ai])).toEqual([]);
    expect(checkersToForce('off-locked', { lt: 'on-locked' }, [lt])).toEqual([]);
  });

  it('offers the checkers when required and none is forced, and stops once one is', () => {
    expect(checkersToForce('on-locked', {}, [lt, ai])).toEqual(['lt', 'ai']);
    expect(checkersToForce('on-locked', {}, [{ ...lt, forceEnabled: true }, ai])).toEqual([]);
  });

  it('asks for a plugin required on its own', () => {
    expect(checkersToForce('off', { lt: 'on-locked' }, [lt, ai])).toEqual(['lt']);
    expect(checkersToForce('off', { lt: 'on-locked' }, [{ ...lt, forceEnabled: true }])).toEqual([]);
  });
});
