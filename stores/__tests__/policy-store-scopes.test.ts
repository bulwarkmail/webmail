import { beforeEach, describe, expect, it, vi } from 'vitest';

// The effective policy follows the active account: its domain and group
// scopes are applied on top of the fetched policy, and switching accounts
// re-resolves it. Settings an earlier account's scope imposed go back to the
// default when the next account has no such scope.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: fetchMock }));

import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore, adminPolicyReleasePatch } from '@/stores/settings-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { policySubjectForClient } from '@/lib/admin/policy-subject';

const POLICY = {
  ...DEFAULT_POLICY,
  scopes: [
    { id: 'two', label: 'Two', match: { domains: ['org-two.test'] }, policy: {
      features: { calendarEnabled: false },
      restrictions: { density: { locked: true, value: 'compact' } },
    } },
    { id: 'team', label: 'Team', match: { groups: ['org-team@example.org'] }, policy: {
      defaults: { showPreview: false },
      organisation: { session: { idleMinutes: 20 } },
    } },
  ],
};

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify(POLICY)));
  usePolicyStore.getState().setPolicySubject(null);
  await usePolicyStore.getState().fetchPolicy();
});

describe('policy store scopes', () => {
  it('keeps explicit admin virtual-view gates OFF after fetching policy', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...DEFAULT_POLICY,
      features: { ...DEFAULT_POLICY.features, crossUnreadViewEnabled: false, crossStarredViewEnabled: false },
    })));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().isFeatureEnabled('crossUnreadViewEnabled')).toBe(false);
    expect(usePolicyStore.getState().isFeatureEnabled('crossStarredViewEnabled')).toBe(false);
    expect(usePolicyStore.getState().rawPolicy.features.crossUnreadViewEnabled).toBe(false);
    expect(usePolicyStore.getState().rawPolicy.features.crossStarredViewEnabled).toBe(false);
    expect(usePolicyStore.getState().isFeatureEnabled('crossAllViewEnabled')).toBe(false);
    expect(usePolicyStore.getState().isFeatureEnabled('unifiedCrossAccountEnabled')).toBe(false);
  });

  it('resolves for the subject and again when it changes', () => {
    const store = usePolicyStore.getState();
    expect(store.isFeatureEnabled('calendarEnabled')).toBe(true);

    store.setPolicySubject({ email: 'org-dave@org-two.test', groups: [] });
    expect(usePolicyStore.getState().isFeatureEnabled('calendarEnabled')).toBe(false);
    expect(usePolicyStore.getState().isSettingLocked('density')).toBe(true);
    expect(usePolicyStore.getState().matchedScopes).toEqual(['two']);
    expect(usePolicyStore.getState().getPolicySource('restrictions.density')).toBe('two');

    store.setPolicySubject({ email: 'org-alice@example.org', groups: ['org-team@example.org'] });
    expect(usePolicyStore.getState().isFeatureEnabled('calendarEnabled')).toBe(true);
    expect(usePolicyStore.getState().isSettingLocked('density')).toBe(false);
    expect(usePolicyStore.getState().getOrganisation().session.idleMinutes).toBe(20);
  });

  it('keeps the subject across a refetch', async () => {
    usePolicyStore.getState().setPolicySubject({ email: 'org-dave@org-two.test', groups: [] });
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().isFeatureEnabled('calendarEnabled')).toBe(false);
  });

  it('knows which domains the fetched scopes cover', async () => {
    expect(usePolicyStore.getState().coversAddress('x@anywhere.test')).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(POLICY), { headers: { 'X-Bulwark-Policy-Domains': 'example.org' } }));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().coversAddress('org-alice@Example.org')).toBe(true);
    expect(usePolicyStore.getState().coversAddress('org-dave@org-two.test')).toBe(false);
  });

  it('resolves another account without switching to it', () => {
    usePolicyStore.getState().setPolicySubject({ email: 'org-carol@example.org', groups: [] });
    const other = usePolicyStore.getState().resolveFor({ email: 'org-bob@example.org', groups: ['org-team@example.org'] });
    expect(other.organisation?.session.idleMinutes).toBe(20);
    expect(usePolicyStore.getState().getOrganisation().session.idleMinutes).toBe(0);
  });

  it('puts a locked value back to the default once the next account has no lock', () => {
    usePolicyStore.getState().setPolicySubject({ email: 'org-dave@org-two.test', groups: [] });
    expect(useSettingsStore.getState().density).toBe('compact');
    usePolicyStore.getState().setPolicySubject({ email: 'org-carol@example.org', groups: [] });
    expect(useSettingsStore.getState().density).toBe('regular');
  });
});

describe('adminPolicyReleasePatch', () => {
  it('leaves values the user chose, and values the next policy still imposes', () => {
    const previous = { defaults: { showPreview: false, density: 'compact' }, restrictions: {} };
    const state = { showPreview: false, density: 'compact', explicitSettings: ['density'] };
    expect(adminPolicyReleasePatch(state, previous, { defaults: {}, restrictions: {} })).toEqual({ showPreview: true });
    expect(adminPolicyReleasePatch(state, previous, { defaults: { showPreview: false }, restrictions: {} })).toEqual({});
    expect(adminPolicyReleasePatch({ ...state, showPreview: true }, previous, {})).toEqual({});
  });
});

describe('policySubjectForClient', () => {
  const client = (types: Record<string, string> | null) => ({
    getUsername: () => 'Org-Alice@Example.org',
    getSharedAccounts: () => [
      { id: 'ci', name: 'org-alice@example.org', isPrimary: true, capabilities: {} },
      { id: 'ch', name: 'org-team@example.org', isPrimary: false, capabilities: {} },
      { id: 'cj', name: 'org-bob@example.org', isPrimary: false, capabilities: {} },
    ] as never,
    getAccountInfo: (id: string) => ({ name: id, isPersonal: id === 'ci', isReadOnly: false, accountCapabilities: {} }),
    getPrincipalTypes: async () => types,
  });

  it('counts only group principals, not mailboxes another user shared', async () => {
    expect(await policySubjectForClient(client({ ch: 'group', cj: 'individual' })))
      .toEqual({ email: 'org-alice@example.org', groups: ['org-team@example.org'] });
  });

  it('falls back to every shared account when the server won\'t say', async () => {
    expect((await policySubjectForClient(client(null)))?.groups)
      .toEqual(['org-bob@example.org', 'org-team@example.org']);
  });
});
