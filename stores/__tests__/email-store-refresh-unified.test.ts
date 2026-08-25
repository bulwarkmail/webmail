import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * refreshCurrentMailbox runs on every Email state push - which a delete, star,
 * or mark-read action all raise. In a unified ("All Mail") or cross-account
 * view, selectedMailbox is a VIRTUAL id (e.g. __cross_all__) that no real
 * folder matches. The single-mailbox path would send it to getEmails as an
 * inMailbox filter, get an empty page back, and the merge would wipe the whole
 * aggregated list. This test pins that a refresh in those views fans out via
 * the unified loaders and keeps the list intact.
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
    receivedAt: '2026-08-03T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

// A single-account client whose getEmails would return an empty page for the
// virtual id - the pre-fix bug. If refreshCurrentMailbox ever calls it in a
// unified view, the list wipes and the assertions below fail.
const makeVirtualIdClient = () =>
  ({
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
  }) as unknown as IJMAPClient & { getEmails: ReturnType<typeof vi.fn> };

describe('refreshCurrentMailbox in unified / cross-account views', () => {
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

  it('cross-account "All Mail" refresh keeps the list instead of wiping it after an action', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b', { $seen: true }); // e.g. just marked read
    // The aggregated fan-out still returns both messages (only b's keywords changed).
    fetchCrossViewMock.mockResolvedValue({
      emails: [a, b],
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
    await useEmailStore.getState().refreshCurrentMailbox(client);

    // List survived and reflects the fanned-out page (b now read).
    const emails = useEmailStore.getState().emails;
    expect(emails.map((e) => e.id)).toEqual(['a', 'b']);
    expect(emails.find((e) => e.id === 'b')?.keywords?.$seen).toBe(true);
    // Fanned out via the cross-view loader; never queried the virtual id directly.
    expect(fetchCrossViewMock).toHaveBeenCalledTimes(1);
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('unified-role view refresh fans out via the unified loader, not the virtual id', async () => {
    const a = makeEmail('a');
    const b = makeEmail('b');
    fetchUnifiedMock.mockResolvedValue({
      emails: [a, b],
      hasMore: false,
      total: 2,
      errors: new Map(),
    });

    useEmailStore.setState({
      selectedMailbox: UNIFIED_INBOX,
      isUnifiedView: true,
      unifiedRole: 'inbox',
      crossView: null,
      emails: [makeEmail('a'), makeEmail('b')],
      totalEmails: 2,
    });

    const client = makeVirtualIdClient();
    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b']);
    expect(fetchUnifiedMock).toHaveBeenCalledTimes(1);
    expect(client.getEmails).not.toHaveBeenCalled();
  });
});
