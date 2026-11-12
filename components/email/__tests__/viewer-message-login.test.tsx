import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { toast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';

// What the reader sends for the open message (the unsubscribe mail, a read
// receipt) and the parts it fetches go through the login the message is in:
// its stamps in a list that mixes accounts, else the login browsed. Ids
// repeat across logins, and another login's address is not the reader's to
// send from. Harness of viewer-send-failures.test.tsx.

vi.mock('@/components/email/rules-menu', () => ({
  RulesPanel: () => null,
  useRulesAvailability: () => ({ availability: 'hidden', target: null }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');

const mailboxes: Mailbox[] = [
  { id: 'a', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function makeEmail(overrides: Record<string, unknown> = {}): Email {
  return {
    id: 'eaaaaab',
    blobId: 'b1',
    threadId: 't1',
    messageId: '<m1@example.org>',
    mailboxIds: { a: true },
    keywords: { $seen: true },
    from: [{ name: 'News', email: 'news@example.org' }],
    to: [{ name: 'B', email: 'b@example.org' }],
    subject: 'Weekly',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Weekly',
    hasAttachment: false,
    size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { '1': { value: 'Weekly news', isTruncated: false } },
    ...overrides,
  } as unknown as Email;
}

type Client = Record<string, ReturnType<typeof vi.fn>> & { getAccountId: () => string };
function makeClient(account: string, user: string): Client {
  return {
    getAccountId: () => account,
    getUsername: vi.fn(() => user),
    getServerUrl: vi.fn(() => 'https://mail.example'),
    sendEmail: vi.fn(async () => ({})),
    sendReadReceipt: vi.fn(async () => {}),
    setKeyword: vi.fn(async () => {}),
    getIdentities: vi.fn(async () => [{ id: 'c', email: user, name: user }]),
    fetchBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
    fetchBlobArrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
    fetchBlobAsObjectUrl: vi.fn(async () => 'blob:x'),
    supportsFiles: vi.fn(() => false),
  } as never;
}

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };
let active: Client;
let other: Client;
let connected: Map<string, Client>;

beforeEach(() => {
  vi.spyOn(toast, 'error').mockImplementation(() => '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  active = makeClient('ee', 'a@example.org');
  other = makeClient('ef', 'b@example.org');
  connected = new Map([['login-a', active], ['login-b', other]]);
  useSettingsStore.setState({ readReceiptResponse: 'ask' } as never);
  useAuthStore.setState({
    activeAccountId: 'login-a',
    client: active as never,
    identities: [{ id: 'b', email: 'a@example.org', name: 'A', mayDelete: false }] as never,
    getClientForAccount: ((id: string) => connected.get(id)) as never,
  } as never);
  useEmailStore.setState({
    isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
    mailboxes, accountMailboxes: { 'login-b': mailboxes }, selectedMailbox: 'a', emails: [], selectedEmail: null,
  } as never);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useSettingsStore.setState(original.settings);
  vi.restoreAllMocks();
});

const UNSUBSCRIBE = { 'List-Unsubscribe': '<mailto:leave@lists.example.org?subject=unsubscribe>' };
const RECEIPT = { 'Disposition-Notification-To': 'News <news@example.org>' };

async function unsubscribe() {
  // The header draws it once per layout.
  fireEvent.click((await screen.findAllByText('email_viewer.unsubscribe_banner.button'))[0]);
  await act(async () => { fireEvent.click(screen.getAllByText('email_viewer.unsubscribe_banner.confirm_button')[0]); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

describe('the unsubscribe mail of the open message', () => {
  it('goes through the login browsed in the sidebar, for a row of its folder', async () => {
    useEmailStore.setState({ viewingAccountId: 'login-b' } as never);
    render(<EmailViewer email={makeEmail({ headers: UNSUBSCRIBE })} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await unsubscribe();
    expect(other.sendEmail).toHaveBeenCalledTimes(1);
    expect(other.sendEmail.mock.calls[0][0]).toEqual(['leave@lists.example.org']);
    expect(active.sendEmail).not.toHaveBeenCalled();
  });

  it('goes through the login a row of the unified inbox is stamped with', async () => {
    useEmailStore.setState({ isUnifiedView: true } as never);
    const email = makeEmail({ headers: UNSUBSCRIBE, sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await unsubscribe();
    expect(other.sendEmail).toHaveBeenCalledTimes(1);
    expect(active.sendEmail).not.toHaveBeenCalled();
  });

  it('is not sent through the active login when the message\'s login is not connected', async () => {
    connected.delete('login-b');
    useEmailStore.setState({ isUnifiedView: true } as never);
    const email = makeEmail({ headers: UNSUBSCRIBE, sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await unsubscribe();
    expect(active.sendEmail).not.toHaveBeenCalled();
    expect(other.sendEmail).not.toHaveBeenCalled();
  });

  it('of the active login\'s own message goes out from the identity that received it, as before', async () => {
    const email = makeEmail({ headers: UNSUBSCRIBE, to: [{ email: 'a@example.org' }] });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await unsubscribe();
    expect(active.sendEmail).toHaveBeenCalledTimes(1);
    const call = active.sendEmail.mock.calls[0];
    expect(call[0]).toEqual(['leave@lists.example.org']);
    expect(call[5]).toBe('b');
    expect(call[6]).toBe('a@example.org');
  });
});

describe('the read receipt of a row of another login', () => {
  const clickSend = async () => {
    await screen.findByText('ignore');
    const send = screen.getAllByText('send').find((el) => el.closest('button')?.parentElement?.textContent?.includes('ignore'))!;
    await act(async () => { fireEvent.click(send); });
  };

  it('in the unified inbox goes out through the row\'s login, from that login\'s address', async () => {
    useEmailStore.setState({ isUnifiedView: true } as never);
    const email = makeEmail({ headers: RECEIPT, sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await clickSend();
    await waitFor(() => expect(other.sendReadReceipt).toHaveBeenCalledTimes(1));
    expect(other.sendReadReceipt.mock.calls[0][0]).toMatchObject({ fromEmail: 'b@example.org', identityId: 'c' });
    await waitFor(() => expect(other.setKeyword).toHaveBeenCalledWith('eaaaaab', '$mdnsent', 'ef'));
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('in a folder of a login browsed in the sidebar goes out through that login', async () => {
    useEmailStore.setState({ viewingAccountId: 'login-b' } as never);
    render(<EmailViewer email={makeEmail({ headers: RECEIPT })} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await clickSend();
    await waitFor(() => expect(other.sendReadReceipt).toHaveBeenCalledTimes(1));
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('is not offered while that login is not connected', async () => {
    connected.delete('login-b');
    useEmailStore.setState({ isUnifiedView: true } as never);
    const email = makeEmail({ headers: RECEIPT, sourceClientAccountId: 'login-b', sourceAccountId: 'ef' });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByText('ignore')).toBeNull();
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
  });

  it('of the active login\'s own message is sent from its own identity, as before', async () => {
    const email = makeEmail({ headers: RECEIPT, to: [{ email: 'a@example.org' }] });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await clickSend();
    await waitFor(() => expect(active.sendReadReceipt).toHaveBeenCalledTimes(1));
    expect(active.sendReadReceipt.mock.calls[0][0]).toMatchObject({ fromEmail: 'a@example.org', identityId: 'b' });
    await waitFor(() => expect(active.setKeyword).toHaveBeenCalledTimes(1));
  });
});

describe('the parts of a row of the unified inbox whose login is not connected', () => {
  it('are not fetched through the active login', async () => {
    connected.delete('login-b');
    useEmailStore.setState({ isUnifiedView: true } as never);
    useSettingsStore.setState({ attachmentImagePreviewsEnabled: true } as never);
    const email = makeEmail({
      sourceClientAccountId: 'login-b', sourceAccountId: 'ef', hasAttachment: true,
      attachments: [{ blobId: 'blob-1', name: 'photo.png', type: 'image/png', size: 10, disposition: 'attachment' }],
    });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(active.fetchBlob).not.toHaveBeenCalled();
    expect(active.fetchBlobArrayBuffer).not.toHaveBeenCalled();
    expect(active.fetchBlobAsObjectUrl).not.toHaveBeenCalled();
  });

  it('control: with the login connected they are fetched through it', async () => {
    useEmailStore.setState({ isUnifiedView: true } as never);
    useSettingsStore.setState({ attachmentImagePreviewsEnabled: true } as never);
    const email = makeEmail({
      sourceClientAccountId: 'login-b', sourceAccountId: 'ef', hasAttachment: true,
      attachments: [{ blobId: 'blob-1', name: 'photo.png', type: 'image/png', size: 10, disposition: 'attachment' }],
    });
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="a" currentMailboxRole="inbox" />);
    await waitFor(() => expect(other.fetchBlob).toHaveBeenCalled());
    expect(active.fetchBlob).not.toHaveBeenCalled();
  });
});
