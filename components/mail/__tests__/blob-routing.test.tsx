import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { JMAPClient } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { threadKeyFor } from '@/lib/thread-utils';

// Keep the real MailApp selection/download handlers and EmailViewer. Stub
// unrelated shell UI and bootstrap requests so no server is contacted.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: ({ emails, onEmailSelect, onOpenAttachment }: {
  emails: Email[]; onEmailSelect: (email: Email) => void; onOpenAttachment: (email: Email, attachment: NonNullable<Email['attachments']>[number]) => void;
}) => <div>{emails.map((email, i) => <div key={i}>
  <button onClick={() => onEmailSelect(email)}>Select {i}</button>
  <button onClick={() => onOpenAttachment(email, email.attachments![0])}>List attachment {i}</button>
</div>)}</div> }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: ({ onDownload, getFileContent }: {
  onDownload: () => void; getFileContent: () => Promise<unknown>;
}) => <div><button onClick={onDownload}>Preview download</button><button onClick={() => void getFileContent()}>Preview fetch</button></div> }));

const { MailApp } = await import('../mail-app');

const sharedMailbox = { id: 'nrichmond:inbox', originalId: 'inbox', name: 'Shared', isShared: true, accountId: 'nrichmond' } as Mailbox;
const primaryMailbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
function message(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email', threadId: 'thread', blobId: 'raw-blob', subject: 'Hello',
    mailboxIds: {}, keywords: { $seen: true }, size: 100,
    receivedAt: '2026-01-01T00:00:00Z', from: [{ email: 'sender@example.com' }], to: [],
    preview: 'Body', hasAttachment: true,
    textBody: [{ partId: '1', type: 'text/plain', size: 4 }], htmlBody: [],
    bodyValues: { '1': { value: 'Body', isEncodingProblem: false, isTruncated: false } },
    attachments: [{ id: '3', partId: '3', blobId: 'same-blob', name: 'attached.eml', type: 'message/rfc822', size: 50 }],
    ...overrides,
  } as Email;
}
function makeClient(accountId: string) {
  return {
    getAccountId: () => accountId, getUsername: () => `${accountId}@example.com`,
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getEmail: vi.fn().mockResolvedValue(message()),
    downloadBlob: vi.fn().mockResolvedValue(undefined),
    fetchBlob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
  };
}
const connectedClients: JMAPClient[] = [];
afterEach(() => {
  connectedClients.splice(0).forEach(client => client.disconnect());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let primary: ReturnType<typeof makeClient>;
let other: ReturnType<typeof makeClient>;
const asClient = (c: ReturnType<typeof makeClient>) => c as unknown as IJMAPClient;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  primary = makeClient('postal12345');
  other = makeClient('other-primary');
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: asClient(primary) as never,
    activeAccountId: 'login-primary', identities: [],
    getClientForAccount: (id) => (id === 'login-primary' ? asClient(primary) : id === 'login-other' ? asClient(other) : undefined) as never,
    getAllConnectedClients: () => new Map([['login-primary', asClient(primary)], ['login-other', asClient(other)]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailAttachmentAction: 'download', mailLayout: 'split', attachmentImagePreviewsEnabled: false, postExportAction: 'none', attachmentDownloadTemplate: '{filename}', filenameLowercase: false } as never);
  useEmailStore.setState({
    emails: [message()], selectedEmail: message(), selectedMailbox: sharedMailbox.id,
    mailboxes: [primaryMailbox, sharedMailbox], viewingAccountId: null, accountMailboxes: {},
    isUnifiedView: false, unifiedRole: null, isScheduledView: false, isLoadingEmail: false,
    isLoading: false, searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedKeyword: null, selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  });
});

async function downloadAttachment() {
  // The viewer renders responsive copies; any Download button exercises the
  // same production handler. The raw RFC822 part is the live reproduction.
  const buttons = await screen.findAllByTitle('download', {}, { timeout: 5000 });
  fireEvent.click(buttons[0]);
}
async function exportEmail() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'more_actions' }))[0]);
  fireEvent.click((await screen.findAllByText('export_email'))[0]);
}

async function connectDownloadClient(serverUrl: string, username: string, accountId: string) {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: {
      [accountId]: { name: 'Primary', isPersonal: true, accountCapabilities: {} },
      nrichmond: { name: 'Shared', isPersonal: false, accountCapabilities: {} },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId },
    apiUrl: `${serverUrl}/jmap/api`,
    downloadUrl: `${serverUrl}/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${serverUrl}/upload/{accountId}`, eventSourceUrl: '',
  }), { status: 200 }));
  const client = new JMAPClient(serverUrl, username, 'test-password');
  connectedClients.push(client);
  await client.connect();
  return client;
}

describe('standard mail UI blob routing', () => {
  it.each([sharedMailbox.id, primaryMailbox.id])('uses the session downloadUrl for %s', async (mailboxId) => {
    const fetchMock = vi.mocked(fetch);
    const realClient = await connectDownloadClient('https://mail.example.com', 'test-login', 'postal12345');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response('attachment', { status: 200 }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    useAuthStore.setState({
      client: realClient,
      getClientForAccount: id => id === 'login-primary' ? realClient : undefined,
      getAllConnectedClients: () => new Map([['login-primary', realClient]]),
    });
    useEmailStore.setState({ selectedMailbox: mailboxId });
    render(<MailApp />);
    await downloadAttachment();
    const owner = mailboxId === sharedMailbox.id ? 'nrichmond' : 'postal12345';
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(new RegExp(`/download/${owner}/same-blob/`));
    expect(String(fetchMock.mock.calls[0][0])).toContain('accept=message%2Frfc822');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: `Basic ${btoa('test-login:test-password')}` }));
  });

  it.each([
    { label: 'direct shared folder', owner: 'nrichmond', login: 'login-primary', filename: 'attachment' },
    { label: 'stamped shared message on another login', owner: 'nrichmond', login: 'login-other', filename: 'attachment' },
    { label: 'primary account', owner: 'postal12345', login: 'login-primary', filename: 'attachment' },
    { label: 'formatted unnamed attachment', owner: 'nrichmond', login: 'login-primary', filename: 'hello-attachment', formatted: true },
  ])('routes Chromium hover and Download for $label', async ({ owner, login, filename, formatted }) => {
    // Enable the real browser capability gate before the viewer mounts.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0.0.0');
    const primaryClient = await connectDownloadClient('https://primary.example.com', 'primary-login', 'postal12345');
    const secondaryClient = await connectDownloadClient('https://secondary.example.com', 'secondary-login', 'secondary-primary');
    useAuthStore.setState({
      client: primaryClient,
      getClientForAccount: id => id === 'login-primary' ? primaryClient : id === 'login-other' ? secondaryClient : undefined,
      getAllConnectedClients: () => new Map([['login-primary', primaryClient], ['login-other', secondaryClient]]),
    });
    useSettingsStore.setState({
      attachmentDownloadTemplate: formatted ? '{subject}-{filename}' : '{filename}',
      filenameLowercase: !!formatted,
    });
    const email = message({
      attachments: [{ partId: '3', blobId: 'same-blob', type: 'message/rfc822', size: 50 }],
      ...(login === 'login-other' ? { sourceClientAccountId: login, sourceAccountId: owner } : {}),
    });
    // message() has a nonempty outer body, so automatic RFC822 unwrapping
    // cannot contribute a third request to this interaction.
    useEmailStore.setState({ selectedEmail: email, selectedMailbox: owner === 'postal12345' ? primaryMailbox.id : sharedMailbox.id });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response('attachment', { status: 200, headers: { 'Content-Type': 'message/rfc822' } }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<MailApp />);
    const downloadButton = (await screen.findAllByTitle('download', {}, { timeout: 5000 }))[0];
    const chip = downloadButton.closest('[draggable="true"]');
    expect(chip).not.toBeNull();

    fireEvent.pointerOver(downloadButton, { pointerType: 'mouse' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const host = login === 'login-other' ? 'https://secondary.example.com' : 'https://primary.example.com';
    const expectedUrl = `${host}/download/${owner}/same-blob/${filename}?accept=message%2Frfc822`;
    const authorization = `Basic ${btoa(`${login === 'login-other' ? 'secondary-login' : 'primary-login'}:test-password`)}`;
    expect(String(fetchMock.mock.calls[0][0])).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: authorization }));

    // Hover still prepares a working DownloadURL for a real drag start.
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(chip!, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('DownloadURL', `message/rfc822:${filename}:blob:test`);
    expect(dataTransfer.effectAllowed).toBe('copyMove');

    fireEvent.click(downloadButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([expectedUrl, expectedUrl]);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(expect.objectContaining({ Authorization: authorization }));
  });

  it('downloads a direct shared-folder message/rfc822 part through its owner', async () => {
    render(<MailApp />);
    await downloadAttachment();
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'nrichmond');
    expect(other.downloadBlob).not.toHaveBeenCalled();
  });

  it('keeps primary-account downloads compatible', async () => {
    useEmailStore.setState({ selectedMailbox: 'inbox' });
    render(<MailApp />);
    await downloadAttachment();
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', undefined);
  });

  it('exports the raw shared message through its owner', async () => {
    render(<MailApp />);
    await exportEmail();
    expect(primary.downloadBlob).toHaveBeenCalledWith('raw-blob', expect.stringMatching(/\.eml$/), 'message/rfc822', 'nrichmond');
  });

  it.each([false, true])('routes Unified selection (automatic=%s) after Email/get replaces the stub', async (automatic) => {
    const stub = message({ bodyValues: undefined, accountId: 'nrichmond', accountLabel: 'Richmond', sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' });
    useEmailStore.setState({ emails: [stub], selectedEmail: automatic ? stub : null, isUnifiedView: true, selectedMailbox: '' });
    render(<MailApp />);
    if (!automatic) fireEvent.click(screen.getByText('Select 0'));
    await waitFor(() => expect(other.getEmail).toHaveBeenCalledWith('email', 'nrichmond'));
    await waitFor(() => expect(useEmailStore.getState().selectedEmail?.bodyValues).toBeDefined());
    await downloadAttachment();
    await exportEmail();
    expect(other.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'nrichmond');
    expect(other.downloadBlob).toHaveBeenCalledWith('raw-blob', expect.any(String), 'message/rfc822', 'nrichmond');
    expect(primary.downloadBlob).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toMatchObject({ sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond', accountLabel: 'Richmond' });
  });

  it('keeps preview fetch and download on the originating owner after navigation', async () => {
    useSettingsStore.setState({ mailAttachmentAction: 'preview' });
    const email = message({ attachments: [{ partId: '3', blobId: 'same-blob', name: 'photo.png', type: 'image/png', size: 50 }] });
    useEmailStore.setState({ selectedEmail: email });
    render(<MailApp />);
    fireEvent.click((await screen.findAllByText('photo.png'))[0]);
    await screen.findByText('Preview download');
    act(() => {
      useEmailStore.setState({ selectedMailbox: 'inbox', selectedEmail: message() });
      useAuthStore.setState({ client: asClient(other) as never, activeAccountId: 'login-other' });
    });
    fireEvent.click(screen.getByText('Preview fetch'));
    fireEvent.click(screen.getByText('Preview download'));
    expect(primary.fetchBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'image/png', 'nrichmond');
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'image/png', 'nrichmond');
    expect(other.downloadBlob).not.toHaveBeenCalled();
  });

  it('honors stamps outside Unified view and isolates overlapping blob ids', async () => {
    const first = message({ sourceClientAccountId: 'login-other', sourceAccountId: 'owner-a' });
    const second = message({ sourceClientAccountId: 'login-primary', sourceAccountId: 'owner-b' });
    useEmailStore.setState({ emails: [first, second], selectedEmail: first });
    render(<MailApp />);
    await downloadAttachment();
    act(() => useEmailStore.setState({ selectedEmail: second }));
    await downloadAttachment();
    expect(other.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'owner-a');
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'owner-b');
  });

  it('keeps a direct shared-folder message unstamped so its thread key matches the row', async () => {
    useEmailStore.setState({ selectedEmail: message({ bodyValues: undefined }) });
    render(<MailApp />);
    await waitFor(() => expect(primary.getEmail).toHaveBeenCalledWith('email', 'nrichmond'));
    await waitFor(() => expect(useEmailStore.getState().selectedEmail?.bodyValues).toBeDefined());
    const selected = useEmailStore.getState().selectedEmail!;
    expect(threadKeyFor(selected)).toBe(threadKeyFor(useEmailStore.getState().emails[0]));
    await downloadAttachment();
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'nrichmond');
  });

  it('keeps an unstamped all-folders search hit on the primary account', async () => {
    useEmailStore.setState({ searchQuery: 'Hello', searchMailboxId: '*' });
    render(<MailApp />);
    await downloadAttachment();
    expect(primary.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', undefined);
  });

  it('uses the browsing login for a direct shared folder on another login', async () => {
    useEmailStore.setState({ viewingAccountId: 'login-other', accountMailboxes: { 'login-other': [sharedMailbox] } });
    render(<MailApp />);
    await downloadAttachment();
    expect(other.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'nrichmond');
    expect(primary.downloadBlob).not.toHaveBeenCalled();
  });

  it('downloads a list attachment using that row rather than the selected message', async () => {
    const row = message({ sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' });
    useEmailStore.setState({ emails: [row], selectedEmail: message() });
    render(<MailApp />);
    fireEvent.click(screen.getByText('List attachment 0'));
    expect(other.downloadBlob).toHaveBeenCalledWith('same-blob', 'attached.eml', 'message/rfc822', 'nrichmond');
    expect(primary.downloadBlob).not.toHaveBeenCalled();
  });

  it('does not route a disconnected stamped login through the primary client', async () => {
    useEmailStore.setState({ selectedEmail: message({ sourceClientAccountId: 'missing-login', sourceAccountId: 'nrichmond' }) });
    render(<MailApp />);
    await downloadAttachment();
    await exportEmail();
    expect(primary.downloadBlob).not.toHaveBeenCalled();
    expect(other.downloadBlob).not.toHaveBeenCalled();
  });

  it('fetches an automatically selected owner even when its email id overlaps the previous selection', async () => {
    const first = message({ sourceClientAccountId: 'login-primary', sourceAccountId: 'owner-a' });
    const second = message({ bodyValues: undefined, sourceClientAccountId: 'login-other', sourceAccountId: 'owner-b' });
    useEmailStore.setState({ emails: [first, second], selectedEmail: first, isUnifiedView: true });
    render(<MailApp />);
    await downloadAttachment();
    act(() => useEmailStore.getState().selectEmail(second));
    await waitFor(() => expect(other.getEmail).toHaveBeenCalledWith('email', 'owner-b'));
    await waitFor(() => expect(useEmailStore.getState().selectedEmail?.bodyValues).toBeDefined());
    await downloadAttachment();
    expect(other.downloadBlob).toHaveBeenCalledWith('same-blob', expect.any(String), 'message/rfc822', 'owner-b');
  });

  it('fetches inline images with the shared owner', async () => {
    useEmailStore.setState({ selectedEmail: message({ attachments: [{ partId: 'image', blobId: 'same-blob', name: 'inline.png', cid: 'cid-image', type: 'image/png', size: 50 }] }) });
    render(<MailApp />);
    await waitFor(() => expect(primary.fetchBlob).toHaveBeenCalledWith('same-blob', 'inline.png', 'image/png', 'nrichmond'));
  });
});
