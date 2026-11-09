import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeBusyAutoShare } from '../free-busy-auto-share';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';

const apply = vi.fn(async () => 'shared' as const);
vi.mock('@/lib/free-busy-share', () => ({ applyAdminFreeBusyShare: (...args: unknown[]) => apply(...(args as [])) }));

const client = { getUsername: () => 'alice@example.org', supportsCalendars: () => true };

function setPolicy(group: string, subjectEmail: string | null) {
  const current = usePolicyStore.getState().policy;
  usePolicyStore.setState({
    loaded: true,
    subject: subjectEmail ? { email: subjectEmail, groups: [] } : null,
    policy: { ...current, organisation: { ...DEFAULT_ORGANISATION_POLICY, calendars: { feeds: [], freeBusyGroup: group } } },
  });
}

describe('FreeBusyAutoShare', () => {
  afterEach(() => {
    apply.mockClear();
    useAuthStore.setState({ client: null, isAuthenticated: false } as never);
  });

  it('shares with the admin group once the policy is resolved for the signed-in account', () => {
    setPolicy('team@example.org', 'someone-else@example.org');
    useAuthStore.setState({ client, isAuthenticated: true } as never);
    render(<FreeBusyAutoShare />);
    // Still resolved for another account: nothing yet.
    expect(apply).not.toHaveBeenCalled();
    act(() => setPolicy('team@example.org', 'alice@example.org'));
    expect(apply).toHaveBeenCalledWith(client, 'team@example.org');
  });

  it('does nothing while the admin set no group', () => {
    setPolicy('', 'alice@example.org');
    useAuthStore.setState({ client, isAuthenticated: true } as never);
    render(<FreeBusyAutoShare />);
    expect(apply).not.toHaveBeenCalled();
  });
});
