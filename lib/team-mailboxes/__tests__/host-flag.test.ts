import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import { hookHandedOver } from '@/lib/plugin-sandbox/handover';
import { listFilterApplies } from '@/lib/plugin-sandbox/list-filters';
import { snapshotHostFeatures } from '@/lib/plugin-sandbox/host-features';
import { anyTeamMailboxOn, teamInboxHandedOver } from '../host-flag';

// While Bulwark's own team mailboxes are on, plugins hear so
// (api.host.features.teamMailboxes), and an older team-inbox copy's row
// badges, buttons and filters are dropped so nobody sees them twice.

const client = {
  getAccountId: () => 'me',
  getUsername: () => 'tm-alice@example.org',
  getAccountInfo: (id: string) => (id === 'g' ? { name: 'tm-team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: {} } : null),
};

function signIn(teamOn: boolean) {
  useAuthStore.setState({ client: client as never, activeAccountId: 'login' } as never);
  const groups = new WeakMap<object, ReadonlySet<string>>();
  groups.set(client, new Set(['g']));
  useConfirmedGroups.setState({ groups, revision: 1 });
  usePolicyStore.setState({ rawPolicy: { ...DEFAULT_POLICY, organisation: { teamMailboxes: { enabled: teamOn } } } as never });
}

afterEach(() => {
  useAuthStore.setState({ client: null, activeAccountId: null } as never);
  useConfirmedGroups.setState({ groups: new WeakMap(), revision: 0 });
  usePolicyStore.setState({ rawPolicy: DEFAULT_POLICY as never });
});

describe('team mailboxes and the team-inbox plugin', () => {
  it('tells plugins when a team mailbox has the feature on', () => {
    signIn(true);
    expect(anyTeamMailboxOn()).toBe(true);
    expect(snapshotHostFeatures().teamMailboxes).toBe(true);
    signIn(false);
    expect(anyTeamMailboxOn()).toBe(false);
    expect(snapshotHostFeatures().teamMailboxes).toBe(false);
  });

  it('drops only team inbox\'s row badges, buttons and filters, and only while it is on', () => {
    expect(hookHandedOver('team-inbox', 'onEmailListItemRender', { teamMailboxes: true } as never)).toBe(true);
    expect(hookHandedOver('team-inbox', 'onEmailListItemRender', { teamMailboxes: false } as never)).toBe(false);
    expect(hookHandedOver('team-inbox', 'onAction', { teamMailboxes: true } as never)).toBe(false);
    expect(hookHandedOver('other', 'onEmailListItemRender', { teamMailboxes: true } as never)).toBe(false);

    const filter = { id: 'mine', label: 'Assigned to me', pluginId: 'team-inbox', key: 'team-inbox:mine', accounts: ['group'] as const };
    signIn(true);
    expect(teamInboxHandedOver('team-inbox')).toBe(true);
    expect(teamInboxHandedOver('other')).toBe(false);
    expect(listFilterApplies(filter as never, { accountKind: 'group' })).toBe(false);
    signIn(false);
    expect(listFilterApplies(filter as never, { accountKind: 'group' })).toBe(true);
  });
});
