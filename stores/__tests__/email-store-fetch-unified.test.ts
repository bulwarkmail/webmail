import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #791: fetchEmails is also called with a unified/cross view's VIRTUAL mailbox
 * id (e.g. __cross_all__) - notably after actions in the aggregated views. The
 * single-mailbox path sent that virtual id to getEmails as `inMailbox`; the
 * server rejects it and the (foreground) catch wipes the list to "no messages".
 * These tests pin that fetchEmails fans out via the unified loaders and never
 * sends the virtual id, so the list stays intact.
 */

const { buildMock, fetchCrossViewMock, fetchUnifiedMock } = vi.hoisted(() => ({
  buildMock: vi.fn(async () => [] as unknown[]),
  fetchCrossViewMock: vi.fn(),
  fetchUnifiedMock: vi.fn(),
}));

vi.mock('@/lib/unified-mailbox', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/unified-mailbox')>();
  return {
    ...actual,
    buildUnifiedAccountClients: buildMock,
    fetchCrossViewEmails: fetchCrossViewMock,
    fetchUnifiedEmails: fetchUnifiedMock,
  };
});

import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { CROSS_ALL, UNIFIED_INBOX } from '@/lib/jmap/types';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const makeEmail = (id: string, keywords: Record<string, boolean> = {}): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords,
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-08-13T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

// A client whose getEmails returns an empty page for the virtual id - the
// pre-fix bug. If fetchEmails ever calls it in a unified view, the list wipes.
const makeVirtualIdClient = () =>
  ({
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
  }) as unknown as IJMAPClient & { getEmails: ReturnType<typeof vi.fn> };

describe('fetchEmails in unified / cross-account views (#791)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockResolvedValue([]);
    useSettingsStore.setState({ emailsPerPage: 25 });
    useEmailStore.setState({
      emails: [],
      totalEmails: 0,
      searchQuery: '',
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
    });
  });

  it('cross-account "All Mail" fans out and keeps the list instead of emptying it', async () => {
    fetchCrossViewMock.mockResolvedValue({
      emails: [makeEmail('a'), makeEmail('b', { $seen: true })],
      hasMore: false,
      total: 2,
      errors: new Map(),
    });
    useEmailStore.setState({
      selectedMailbox: CROSS_ALL,
      isUnifiedView: true,
      crossView: 'all',
      emails: [makeEmail('a'), makeEmail('b')],
      totalEmails: 2,
    });

    const client = makeVirtualIdClient();
    await useEmailStore.getState().fetchEmails(client);

    const emails = useEmailStore.getState().emails;
    expect(emails.map((e) => e.id)).toEqual(['a', 'b']); // not emptied
    expect(emails.find((e) => e.id === 'b')?.keywords?.$seen).toBe(true);
    expect(fetchCrossViewMock).toHaveBeenCalledTimes(1);
    expect(client.getEmails).not.toHaveBeenCalled(); // never sent __cross_all__
  });

  it('unified-role view fans out via the unified loader, not the virtual id', async () => {
    fetchUnifiedMock.mockResolvedValue({
      emails: [makeEmail('a'), makeEmail('b')],
      hasMore: false,
      total: 2,
      errors: new Map(),
    });
    useEmailStore.setState({
      selectedMailbox: UNIFIED_INBOX,
      isUnifiedView: true,
      unifiedRole: 'inbox',
      crossView: null,
      emails: [makeEmail('a')],
      totalEmails: 1,
    });

    const client = makeVirtualIdClient();
    await useEmailStore.getState().fetchEmails(client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b']);
    expect(fetchUnifiedMock).toHaveBeenCalledTimes(1);
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('an explicit virtual mailboxId argument is also routed (not sent to getEmails)', async () => {
    fetchCrossViewMock.mockResolvedValue({ emails: [makeEmail('a')], hasMore: false, total: 1, errors: new Map() });
    useEmailStore.setState({ isUnifiedView: true, crossView: 'all', selectedMailbox: 'inbox' });

    const client = makeVirtualIdClient();
    await useEmailStore.getState().fetchEmails(client, CROSS_ALL);

    expect(fetchCrossViewMock).toHaveBeenCalledTimes(1);
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('a virtual id with no resolved view leaves the list untouched (no query, no wipe)', async () => {
    useEmailStore.setState({
      selectedMailbox: CROSS_ALL,
      isUnifiedView: true,
      crossView: null,
      unifiedRole: null,
      emails: [makeEmail('a'), makeEmail('b')],
      totalEmails: 2,
    });

    const client = makeVirtualIdClient();
    await useEmailStore.getState().fetchEmails(client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b']); // not wiped
    expect(fetchCrossViewMock).not.toHaveBeenCalled();
    expect(fetchUnifiedMock).not.toHaveBeenCalled();
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('a real folder still uses the single-mailbox getEmails path', async () => {
    const client = ({
      getEmails: vi.fn(async () => ({ emails: [makeEmail('r')], hasMore: false, total: 1 })),
    }) as unknown as IJMAPClient & { getEmails: ReturnType<typeof vi.fn> };
    useEmailStore.setState({ selectedMailbox: 'inbox', isUnifiedView: false, crossView: null, unifiedRole: null });

    await useEmailStore.getState().fetchEmails(client, 'inbox');

    expect(client.getEmails).toHaveBeenCalledTimes(1);
    expect(fetchCrossViewMock).not.toHaveBeenCalled();
    expect(fetchUnifiedMock).not.toHaveBeenCalled();
  });
});
