import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A real folder could show Unified Inbox rows with "Inbox" badges while the
 * sidebar still had the folder selected (#1102). Ways in:
 * - a fetchUnifiedEmails/fetchCrossView still in flight when the user picked
 *   the folder resolved afterwards and overwrote the folder's list;
 * - a caller that awaited the unified account list before starting the fetch
 *   started it after the user had left, switching the unified view back on
 *   over the folder, so the next refresh (e.g. after a delete) loaded the
 *   unified inbox;
 * - picking a folder without leaving the unified view first (history
 *   restore, a folder's unread badge, a Pro-sidebar account folder).
 *
 * viewToken is bumped by every view-changing action. The fetches check it on
 * return; callers that await first check it via captureViewToken().
 */

const { fetchCrossViewMock, fetchUnifiedMock } = vi.hoisted(() => ({
  fetchCrossViewMock: vi.fn(),
  fetchUnifiedMock: vi.fn(),
}));

vi.mock('@/lib/unified-mailbox', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/unified-mailbox')>();
  return {
    ...actual,
    fetchCrossViewEmails: fetchCrossViewMock,
    fetchUnifiedEmails: fetchUnifiedMock,
  };
});

import { captureViewToken, useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email } from '@/lib/jmap/types';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';

const makeEmail = (id: string): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-08-13T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
  }) as unknown as Email;

describe('viewToken guards against late-resolving unified fetches (#1102)', () => {
  let resolveUnified!: (value: unknown) => void;
  let resolveCross!: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ emailsPerPage: 25 });
    useEmailStore.setState({
      emails: [],
      totalEmails: 0,
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      selectedMailbox: '',
      selectedKeyword: null,
      viewingAccountId: null,
    });
    fetchUnifiedMock.mockImplementation(
      () => new Promise((resolve) => { resolveUnified = resolve; }),
    );
    fetchCrossViewMock.mockImplementation(
      () => new Promise((resolve) => { resolveCross = resolve; }),
    );
  });

  it('a late-resolving fetchUnifiedEmails does not stomp a folder selected afterward', async () => {
    const accounts: UnifiedAccountClient[] = [];

    // Kick off a unified fetch and don't await it yet - simulates it being
    // in flight when the user clicks away.
    const pending = useEmailStore.getState().fetchUnifiedEmails(accounts, 'inbox');
    expect(useEmailStore.getState().isUnifiedView).toBe(true);

    // User navigates to a real folder (e.g. "Later") before the fetch settles.
    useEmailStore.getState().selectMailbox('later-folder-id');
    expect(useEmailStore.getState().isUnifiedView).toBe(false);
    expect(useEmailStore.getState().selectedMailbox).toBe('later-folder-id');

    // The stale unified fetch now resolves.
    resolveUnified({
      emails: [makeEmail('unified-a'), makeEmail('unified-b')],
      hasMore: false,
      total: 2,
      errors: new Map(),
    });
    await pending;

    // It must not have re-entered unified view or overwritten the folder's state.
    expect(useEmailStore.getState().isUnifiedView).toBe(false);
    expect(useEmailStore.getState().selectedMailbox).toBe('later-folder-id');
    expect(useEmailStore.getState().emails.map((e) => e.id)).not.toContain('unified-a');
  });

  it('a fresh fetchUnifiedEmails call still applies its own results normally', async () => {
    fetchUnifiedMock.mockResolvedValueOnce({
      emails: [makeEmail('a')],
      hasMore: false,
      total: 1,
      errors: new Map(),
    });

    await useEmailStore.getState().fetchUnifiedEmails([], 'inbox');

    expect(useEmailStore.getState().isUnifiedView).toBe(true);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a']);
  });

  it('a late-resolving fetchCrossView does not overwrite a folder selected afterward', async () => {
    const pending = useEmailStore.getState().fetchCrossView([], 'unread');
    useEmailStore.getState().selectMailbox('later-folder-id');
    useEmailStore.setState({ emails: [makeEmail('folder-a')] });

    resolveCross({ emails: [makeEmail('cross-a')], hasMore: false, total: 1, errors: new Map() });
    await pending;

    const state = useEmailStore.getState();
    expect(state.isUnifiedView).toBe(false);
    expect(state.crossView).toBeNull();
    expect(state.emails.map((e) => e.id)).toEqual(['folder-a']);
  });

  it('picking another account\'s folder leaves the unified view and drops its pending fetch', async () => {
    const pending = useEmailStore.getState().fetchUnifiedEmails([], 'inbox');
    useEmailStore.getState().selectAccountMailbox('acc-2', 'later-folder-id');

    let state = useEmailStore.getState();
    expect(state.isUnifiedView).toBe(false);
    expect(state.unifiedRole).toBeNull();
    expect(state.viewingAccountId).toBe('acc-2');

    useEmailStore.setState({ emails: [makeEmail('folder-a')] });
    resolveUnified({ emails: [makeEmail('unified-a')], hasMore: false, total: 1, errors: new Map() });
    await pending;

    state = useEmailStore.getState();
    expect(state.isUnifiedView).toBe(false);
    expect(state.emails.map((e) => e.id)).toEqual(['folder-a']);
  });

  it('captureViewToken tells a caller that the user left while it was awaiting', () => {
    // mail-app selects the unified row, then awaits the account list before
    // it calls fetchUnifiedEmails.
    useEmailStore.getState().selectMailbox('__unified_inbox__');
    const isSameView = captureViewToken();
    expect(isSameView()).toBe(true);

    useEmailStore.getState().exitUnifiedView();
    useEmailStore.getState().selectMailbox('later-folder-id');

    expect(isSameView()).toBe(false);
  });

  it('captureViewToken stays current when nothing navigated', () => {
    useEmailStore.getState().selectMailbox('__unified_inbox__');
    const isSameView = captureViewToken();
    useEmailStore.setState({ emails: [makeEmail('a')] });
    expect(isSameView()).toBe(true);
  });
});
