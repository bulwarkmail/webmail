import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderRetentionLine, RetentionNotice } from '../retention-notice';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useRecoveryStore } from '@/stores/recovery-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import type { Mailbox } from '@/lib/jmap/types';
import { useEmailStore } from '@/stores/email-store';
import { resetAccountSubjects, useAccountSubjects } from '@/lib/org/account-subjects';

// The retention line of Trash and Junk (Organisation > Notices): the
// admin's days, one line in each folder, sharing Trash's line with the
// Recover deleted items link when that shows.

vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ stalwartFeaturesEnabled: true, isLoading: false }) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));

const TRASH = { id: 't', name: 'Trash', role: 'trash', accountId: 'ci' } as Mailbox;
const JUNK = { id: 'j', name: 'Junk', role: 'junk', accountId: 'ci' } as Mailbox;
const INBOX = { id: 'i', name: 'Inbox', role: 'inbox', accountId: 'ci' } as Mailbox;

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();

function setup(retention: { trashDays: number; junkDays: number }, recovery = false) {
  const policy = { ...initialPolicy.policy, restrictions: {}, organisation: { ...DEFAULT_ORGANISATION_POLICY, retention } };
  usePolicyStore.setState({ loaded: true, rawPolicy: policy, policy });
  const client = {
    getAccountId: () => 'ci',
    getUsername: () => 'a@example.org',
    advertisesArchivedItems: () => recovery,
    queryArchivedItemIds: vi.fn(async () => ({ ids: [], total: null })),
    hasArchivedEmail: vi.fn(async () => true),
  };
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc-a' });
  usePolicyStore.setState({ subject: { email: 'a@example.org', groups: [] } });
}

afterEach(() => {
  cleanup();
  useRecoveryStore.getState().reset();
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
});

describe('retention line', () => {
  it('says how many days Trash and Junk keep mail', async () => {
    setup({ trashDays: 30, junkDays: 14 });
    const { unmount } = render(<FolderRetentionLine mailbox={TRASH} />);
    await act(async () => {});
    expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":30}');
    unmount();
    render(<FolderRetentionLine mailbox={JUNK} />);
    expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":14}');
  });

  it('shows nothing when the admin set no days, or in other folders', async () => {
    setup({ trashDays: 0, junkDays: 0 });
    render(<FolderRetentionLine mailbox={TRASH} />);
    render(<FolderRetentionLine mailbox={JUNK} />);
    await act(async () => {});
    expect(screen.queryByTestId('retention-notice')).toBeNull();
    cleanup();
    setup({ trashDays: 30, junkDays: 30 });
    render(<FolderRetentionLine mailbox={INBOX} />);
    render(<RetentionNotice role="inbox" />);
    expect(screen.queryByTestId('retention-notice')).toBeNull();
  });

  it('shares one line with Recover deleted items in Trash', async () => {
    setup({ trashDays: 30, junkDays: 30 }, true);
    render(<FolderRetentionLine mailbox={TRASH} />);
    const line = await screen.findByTestId('trash-recovery-link');
    expect(line.querySelector('[data-testid="retention-notice"]')?.textContent).toBe('line:{"count":30}');
    expect(line.textContent).toContain('trash_link');
    expect(screen.getAllByTestId('retention-notice')).toHaveLength(1);
  });

  it('follows the scopes of another account opened from the sidebar, and of a Pro folder tab\u2019s account', async () => {
    setup({ trashDays: 30, junkDays: 30 });
    const policy = {
      ...usePolicyStore.getState().policy,
      scopes: [{ id: 'other', label: 'Other', match: { domains: ['other.example'] }, policy: { organisation: { retention: { trashDays: 7, junkDays: 3 } } } }],
    };
    usePolicyStore.setState({ rawPolicy: policy });
    const otherClient = { getUsername: () => 'b@other.example' };
    useAuthStore.setState({ getClientForAccount: ((id: string) => (id === 'acc-b' ? otherClient : undefined)) as never });
    useAccountSubjects.setState({ subjects: { 'acc-b': { email: 'b@other.example', groups: [] } }, settled: { 'acc-b': true } });
    useEmailStore.setState({ viewingAccountId: 'acc-b' });
    try {
      render(<FolderRetentionLine mailbox={JUNK} />);
      expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":3}');
      cleanup();
      useEmailStore.setState({ viewingAccountId: null });
      render(<RetentionNotice role="trash" accountId="acc-b" />);
      expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":7}');
    } finally {
      useEmailStore.setState({ viewingAccountId: null });
      resetAccountSubjects();
    }
  });
});
