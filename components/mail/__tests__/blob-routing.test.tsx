import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox, ThreadGroup } from '@/lib/jmap/types';
import { JMAPClient } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { useUIStore } from '@/stores/ui-store';
import { threadKeyFor } from '@/lib/thread-utils';
import { useToastStore } from '@/stores/toast-store';
import { ToastContainer } from '@/components/ui/toast';

const device = vi.hoisted(() => ({ mobile: false }));

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
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => [],
  cachedIdentitiesForAccount: () => undefined,
}));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.mobile, isTablet: false, isDesktop: !device.mobile }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  narrowerThan: (px: number) => `(width < ${px / 16}rem)`,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', async () => {
  const { ThreadListItem } = await import('@/components/email/thread-list-item');
  const { groupEmailsByThread } = await import('@/lib/thread-utils');
  return { EmailList: ({ emails, onEmailSelect, onOpenAttachment, onOpenConversation }: {
    emails: Email[];
    onOpenConversation: (thread: ThreadGroup) => void;
    onEmailSelect: (email: Email) => void;
    onOpenAttachment: (email: Email, attachment: NonNullable<Email['attachments']>[number]) => void;
  }) => device.mobile ? (
    <div>{groupEmailsByThread(emails).map(thread => (
      <ThreadListItem key={thread.threadKey} thread={thread} isExpanded={false}
        onToggleExpand={() => {}} onEmailSelect={onEmailSelect} onOpenConversation={onOpenConversation} />
    ))}</div>
  ) : (
    <div>{emails.map((email, i) => <div key={i}>
      <button onClick={() => onEmailSelect(email)}>Select {i}</button>
      <button onClick={() => onOpenAttachment(email, email.attachments![0])}>List attachment {i}</button>
    </div>)}</div>
  ) };
});
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: ({ onDownload, getFileContent }: {
  onDownload: () => void; getFileContent: () => Promise<unknown>;
}) => <div><button onClick={onDownload}>Preview download</button><button onClick={() => void getFileContent()}>Preview fetch</button></div> }));

const { MailApp } = await import('../mail-app');
const { ConversationEmailBody } = await import('@/components/email/thread-conversation-view');
const { EmailViewer } = await import('@/components/email/email-viewer');
const { ProEmailTabBody } = await import('@/components/pro/pro-email-tab-body');
const { ProFolderTabBody } = await import('@/components/pro/pro-folder-tab-body');

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
  device.mobile = false;
  useUIStore.setState({ isMobile: false });
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
  useSettingsStore.setState({ interfaceLayout: 'default', markAsReadDelay: -1, enableUnifiedMailbox: false, mailAttachmentAction: 'download', mailLayout: 'split', attachmentImagePreviewsEnabled: false, postExportAction: 'none', attachmentDownloadTemplate: '{filename}', filenameLowercase: false } as never);
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
/** The button that covers an attachment's tile and opens it like a click on the tile. */
async function findAttachmentOpener(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const tile = document.querySelector<HTMLElement>(`[data-attachment-name="${name}"]`);
    if (!tile) throw new Error(`No attachment named ${name}`);
    return within(tile).getAllByRole('button')[0];
  }, { timeout: 5000 });
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

describe('standard mail attachment download feedback', () => {
  const bytes = 'synthetic attachment bytes';
  const downloadUrl = 'https://mail.example.com/download/nrichmond/same-blob/report.txt?accept=application%2Foctet-stream';
  const response = () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });

  function DownloadToasts() {
    const toasts = useToastStore(state => state.toasts);
    return <ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} />;
  }

  beforeEach(() => useToastStore.getState().clearToasts());
  afterEach(() => useToastStore.getState().clearToasts());

  async function openAttachment(action: 'Download button' | 'attachment click') {
    const client = await connectDownloadClient('https://mail.example.com', 'test-login', 'postal12345');
    useAuthStore.setState({ client,
      getClientForAccount: id => id === 'login-primary' ? client : undefined,
      getAllConnectedClients: () => new Map([['login-primary', client]]),
    });
    const selected = message({ attachments: [{ partId: '3', blobId: 'same-blob', name: 'report.txt', type: 'application/octet-stream', size: bytes.length }] });
    useEmailStore.setState({ selectedEmail: selected, emails: [selected] });
    // The explicit Download button must also bypass the Preview preference.
    useSettingsStore.setState({ mailAttachmentAction: action === 'Download button' ? 'preview' : 'download' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('Unexpected network request'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const downloads: { href: string; name: string; connected: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, name: this.download, connected: document.body.contains(this) });
    });
    render(<><MailApp /><DownloadToasts /></>);
    const button = (await screen.findAllByTitle('download', {}, { timeout: 5000 }))[0];
    const opener = await findAttachmentOpener('report.txt');
    const click = () => fireEvent.click(action === 'Download button' ? button : opener);

    function expectRequests(count: number) {
      expect(fetchMock).toHaveBeenCalledTimes(count);
      for (let i = 0; i < count; i++) expectBlobRequest(downloadUrl, 'test-login', i);
    }
    async function expectDownload(count: number) {
      await waitFor(() => expect(downloads).toHaveLength(1), { timeout: 4000 });
      expectRequests(count);
      expect(downloads[0]).toEqual({ href: 'blob:test', name: 'report.txt', connected: true });
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
      expect(await blob.text()).toBe(bytes);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    }
    return { click, fetchMock, errors, downloads, button, selected, expectRequests, expectDownload };
  }

  describe.each(['Download button', 'attachment click'] as const)('%s', action => {
    it.each(['HTTP 403', 'HTTP 503', 'exhausted network retry'] as const)(
      'reports %s once and downloads on another click after recovery', async failure => {
        const { click, fetchMock, errors, downloads, button, selected, expectRequests, expectDownload } = await openAttachment(action);
        const attempts = failure === 'exhausted network retry' ? 2 : 1;
        if (failure === 'exhausted network retry') {
          fetchMock.mockRejectedValueOnce(new TypeError('synthetic offline'))
            .mockRejectedValueOnce(new TypeError('synthetic offline'));
        } else {
          fetchMock.mockResolvedValueOnce(new Response('synthetic refusal', { status: failure === 'HTTP 403' ? 403 : 503 }));
        }
        click();
        await waitFor(() => expect(errors).toHaveBeenCalledWith('Failed to download attachment:', expect.any(Error)), { timeout: 4000 });
        expectRequests(attempts);
        expect(downloads).toEqual([]);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(button).toBeEnabled();
        expect(useEmailStore.getState().selectedEmail).toBe(selected);
        // The shared next-intl test mock returns translation keys verbatim.
        expect(useToastStore.getState().toasts).toEqual([
          expect.objectContaining({ type: 'error', title: 'files.download_error' }),
        ]);
        expect(screen.getByText('files.download_error')).toBeVisible();

        // Reuse the same UI node, client, owner and blob without navigation.
        fetchMock.mockResolvedValueOnce(response());
        click();
        await expectDownload(attempts + 1);
        expect(useEmailStore.getState().selectedEmail).toBe(selected);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(useToastStore.getState().toasts).toHaveLength(1);
      },
    );

    it('does not notify when the existing automatic network retry recovers', async () => {
      const { click, fetchMock, errors, selected, expectDownload } = await openAttachment(action);
      fetchMock.mockRejectedValueOnce(new TypeError('synthetic transient')).mockResolvedValueOnce(response());
      click();
      await expectDownload(2);
      expect(errors).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([]);
      expect(screen.queryByText('files.download_error')).not.toBeInTheDocument();
      expect(useEmailStore.getState().selectedEmail).toBe(selected);
    });
  });

  it('finishes the original attachment download after switching messages', async () => {
    const { click, fetchMock, errors, downloads, expectDownload } = await openAttachment('Download button');
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const next = message({ id: 'next', subject: 'Next', sourceAccountId: 'different-owner', attachments: [] });
    act(() => useEmailStore.setState({ selectedEmail: next }));
    expect(document.querySelector('[data-attachment-name="report.txt"]')).toBeNull();
    expect(downloads).toEqual([]);
    await act(async () => finish(response()));
    await expectDownload(1);
    expect(useEmailStore.getState().selectedEmail).toBe(next);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

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
    expect(primary.downloadBlob).toHaveBeenCalledWith('raw-blob', expect.stringMatching(/\.eml$/), 'message/rfc822', 'nrichmond', { kind: 'export' });
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
    expect(other.downloadBlob).toHaveBeenCalledWith('raw-blob', expect.any(String), 'message/rfc822', 'nrichmond', { kind: 'export' });
    expect(primary.downloadBlob).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toMatchObject({ sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond', accountLabel: 'Richmond' });
  });

  it('keeps preview fetch and download on the originating owner after navigation', async () => {
    useSettingsStore.setState({ mailAttachmentAction: 'preview' });
    const email = message({ attachments: [{ partId: '3', blobId: 'same-blob', name: 'photo.png', type: 'image/png', size: 50 }] });
    useEmailStore.setState({ selectedEmail: email });
    render(<MailApp />);
    fireEvent.click(await findAttachmentOpener('photo.png'));
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


// Exercise real thread-row clicks, MailApp conversation loading, the card body,
// and JMAP URL/authentication. Only unrelated shell UI and responses are mocked.
async function conversationClients() {
  const a = await connectDownloadClient('https://primary.example.com', 'primary-login', 'postal12345');
  const b = await connectDownloadClient('https://secondary.example.com', 'secondary-login', 'secondary-primary');
  useAuthStore.setState({ client: a,
    getClientForAccount: id => id === 'login-primary' ? a : id === 'login-other' ? b : undefined,
    getAllConnectedClients: () => new Map([['login-primary', a], ['login-other', b]]),
  });
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => new Response('blob bytes', {
    status: 200, headers: { 'Content-Type': 'image/png' },
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return { a, b, fetchMock };
}
const cardAttachment = { partId: '3', blobId: 'same-blob', name: 'card.png', type: 'image/png', size: 50 };
function conversationMessage(overrides: Partial<Email> = {}) {
  return message({ id: 'card', subject: 'Routing conversation', attachments: [cardAttachment], ...overrides });
}
function inlineMessage(overrides: Partial<Email> = {}) {
  return conversationMessage({
    htmlBody: [{ partId: '1', blobId: 'html-blob', type: 'text/html', size: 30 }], textBody: [],
    bodyValues: { '1': { value: '<img src="cid:test-image">', isTruncated: false, isEncodingProblem: false } },
    attachments: [{ ...cardAttachment, cid: 'test-image' }], ...overrides,
  });
}
function expectBlobRequest(url: string, login: string, index = 0) {
  const calls = vi.mocked(fetch).mock.calls;
  expect(String(calls[index][0])).toBe(url);
  expect(calls[index][1]?.headers).toEqual(expect.objectContaining({
    Authorization: `Basic ${btoa(`${login}:test-password`)}`,
  }));
}
async function openPhoneConversation(ref: Email, threadClient: JMAPClient, selected: Email | null = null, unified = true) {
  device.mobile = true;
  useUIStore.setState({ isMobile: true });
  const older = { ...ref, id: 'older', receivedAt: '2025-12-31T00:00:00Z', attachments: [] };
  // Email/get/Thread/get results have no UI source stamps.
  const raw = (email: Email) => ({ ...email, sourceClientAccountId: undefined, sourceAccountId: undefined });
  const threadFetch = vi.spyOn(threadClient, 'getThreadEmails').mockResolvedValue([raw(ref), raw(older)]);
  useEmailStore.setState({ emails: [ref, older], selectedEmail: selected,
    selectedMailbox: unified ? '__unified_inbox__' : sharedMailbox.id,
    isUnifiedView: unified, unifiedRole: unified ? 'inbox' : null,
  });
  render(<MailApp />);
  fireEvent.click(await screen.findByText('Routing conversation'));
  await screen.findByRole('button', { name: 'email_viewer.back_to_list' });
  await waitFor(() => expect(threadFetch).toHaveBeenCalled());
  await screen.findByText('threads.messages_count');
  return threadFetch;
}

describe('conversation blob routing', () => {
  it.each([
    { source: 'direct shared folder', login: 'login-primary', owner: 'nrichmond', unified: false },
    { source: 'secondary login and shared owner', login: 'login-other', owner: 'nrichmond', unified: true },
    { source: 'primary account', login: 'login-primary', owner: 'postal12345', unified: true },
  ])('routes phone CID images for $source', async ({ login, owner, unified }) => {
    const { a, b, fetchMock } = await conversationClients();
    const ref = inlineMessage(unified ? { sourceClientAccountId: login, sourceAccountId: owner } : {});
    const threadFetch = await openPhoneConversation(ref, login === 'login-other' ? b : a, null, unified);
    expect(threadFetch).toHaveBeenCalledWith('thread', unified ? owner : 'nrichmond');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectBlobRequest(`https://${login === 'login-other' ? 'secondary' : 'primary'}.example.com/download/${owner}/same-blob/card.png?accept=image%2Fpng`, login === 'login-other' ? 'secondary-login' : 'primary-login');
  });

  it('routes a direct shared-folder conversation through the browsing login', async () => {
    const { b, fetchMock } = await conversationClients();
    useEmailStore.setState({ viewingAccountId: 'login-other', accountMailboxes: { 'login-other': [sharedMailbox] } });
    await openPhoneConversation(inlineMessage(), b, null, false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectBlobRequest('https://secondary.example.com/download/nrichmond/same-blob/card.png?accept=image%2Fpng', 'secondary-login');
  });

  it.each([
    { selection: 'null', login: 'login-other', owner: 'nrichmond' },
    { selection: 'unrelated', login: 'login-other', owner: 'nrichmond' },
    { selection: 'null', login: 'login-primary', owner: 'postal12345' },
  ])('downloads the phone card on $login with $selection selectedEmail', async ({ selection, login, owner }) => {
    const { a, b, fetchMock } = await conversationClients();
    const selected = selection === 'null' ? null : message({ id: 'unrelated', subject: 'Other message', sourceClientAccountId: 'login-primary', sourceAccountId: 'unrelated-owner' });
    await openPhoneConversation(conversationMessage({ sourceClientAccountId: login, sourceAccountId: owner }), login === 'login-other' ? b : a, selected);
    fireEvent.click(await screen.findByRole('button', { name: /card.png/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectBlobRequest(`https://${login === 'login-other' ? 'secondary' : 'primary'}.example.com/download/${owner}/same-blob/card.png?accept=image%2Fpng`, login === 'login-other' ? 'secondary-login' : 'primary-login');
  });

  it.each([false, true])('retains phone preview routing after navigation (direct shared=%s)', async direct => {
    const { a, b, fetchMock } = await conversationClients();
    useSettingsStore.setState({ mailAttachmentAction: 'preview' });
    const ref = conversationMessage(direct ? {} : { sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' });
    await openPhoneConversation(ref, direct ? a : b, null, !direct);
    fireEvent.click(await screen.findByRole('button', { name: /card.png/ }));
    await screen.findByText('Preview fetch');
    act(() => {
      useEmailStore.setState({ selectedMailbox: 'inbox', selectedEmail: message({ sourceClientAccountId: 'login-primary', sourceAccountId: 'other-owner' }) });
      useAuthStore.setState({ client: b, activeAccountId: 'login-other' });
    });
    fireEvent.click(screen.getByText('Preview fetch'));
    fireEvent.click(screen.getByText('Preview download'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const index of [0, 1]) expectBlobRequest(`https://${direct ? 'primary' : 'secondary'}.example.com/download/nrichmond/same-blob/card.png?accept=image%2Fpng`, direct ? 'primary-login' : 'secondary-login', index);
  });

  it.each([false, true])('routes Mountain View expanded sibling CID and attachment (mobile=%s)', async mobile => {
    const { b, fetchMock } = await conversationClients();
    device.mobile = mobile;
    useUIStore.setState({ isMobile: mobile });
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
    const sibling = inlineMessage({ attachments: [...inlineMessage().attachments!, { ...cardAttachment, name: 'download.png', partId: '4' }], id: 'sibling', from: [{ name: 'Older sender', email: 'older@example.com' }], sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' });
    const open = conversationMessage({ id: 'open', attachments: [], receivedAt: '2026-01-02T00:00:00Z', sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' });
    const download = vi.fn();
    const { container } = render(<EmailViewer email={open} blobSource={{ client: b, accountId: 'nrichmond' }} mvConversation={[sibling, open]} onDownloadAttachment={download} />);
    fireEvent.click(await screen.findByText('Older sender'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectBlobRequest('https://secondary.example.com/download/nrichmond/same-blob/card.png?accept=image%2Fpng', 'secondary-login');
    const card = container.querySelector('[data-mv-conversation-expanded]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /download.png/ }));
    expect(download).toHaveBeenCalledWith('same-blob', 'download.png', 'image/png', false, expect.objectContaining({ client: b, accountId: 'nrichmond' }));
  });

  it('downloads overlapping card blob ids from successive phone conversations', async () => {
    const { a, b, fetchMock } = await conversationClients();
    device.mobile = true;
    useUIStore.setState({ isMobile: true });
    const one = conversationMessage({ subject: 'First conversation', sourceClientAccountId: 'login-primary', sourceAccountId: 'owner-a' });
    const two = conversationMessage({ subject: 'Second conversation', sourceClientAccountId: 'login-other', sourceAccountId: 'owner-b' });
    const rows = [one, { ...one, id: 'older' }, two, { ...two, id: 'older' }];
    vi.spyOn(a, 'getThreadEmails').mockResolvedValue([one]);
    vi.spyOn(b, 'getThreadEmails').mockResolvedValue([two]);
    useEmailStore.setState({ emails: rows, selectedEmail: null, selectedMailbox: '__unified_inbox__', isUnifiedView: true, unifiedRole: 'inbox' });
    render(<MailApp />);
    fireEvent.click(await screen.findByText('First conversation'));
    fireEvent.click(await screen.findByRole('button', { name: /card.png/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'email_viewer.back_to_list' }));
    fireEvent.click(screen.getByText('Second conversation'));
    fireEvent.click(await screen.findByRole('button', { name: /card.png/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expectBlobRequest('https://primary.example.com/download/owner-a/same-blob/card.png?accept=image%2Fpng', 'primary-login', 0);
    expectBlobRequest('https://secondary.example.com/download/owner-b/same-blob/card.png?accept=image%2Fpng', 'secondary-login', 1);
  });

  it.each(['owner', 'client'] as const)('scopes Mountain View pending loads when only the %s changes', async changed => {
    const { a, b, fetchMock } = await conversationClients();
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' });
    const nextOwner = changed === 'owner' ? 'next-owner' : 'nrichmond';
    const nextMailbox = { ...sharedMailbox, id: 'next-inbox', accountId: nextOwner };
    const open = conversationMessage({ id: 'open', attachments: [], receivedAt: '2026-01-02T00:00:00Z' });
    const sibling = (label: string) => conversationMessage({
      id: 'sibling', keywords: {}, from: [{ name: label, email: 'older@example.com' }],
    });
    const getThreadA = vi.spyOn(a, 'getThread').mockResolvedValue({ id: 'thread', emailIds: ['sibling', 'open'] });
    const getThreadB = vi.spyOn(b, 'getThread').mockResolvedValue({ id: 'thread', emailIds: ['sibling', 'open'] });
    vi.spyOn(a, 'getSomeEmails').mockImplementation(async (_ids, owner) => [sibling(owner === nextOwner && changed === 'owner' ? 'Next sender' : 'First sender'), { ...open }]);
    vi.spyOn(b, 'getSomeEmails').mockResolvedValue([sibling('Next sender'), { ...open }]);
    useEmailStore.setState({ emails: [open], selectedEmail: open, selectedMailbox: sharedMailbox.id,
      mailboxes: [sharedMailbox, nextMailbox], accountMailboxes: { 'login-other': [sharedMailbox, nextMailbox] },
    });
    const { container } = render(<MailApp />);
    await screen.findByText('First sender');
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => useEmailStore.setState({
      selectedMailbox: nextMailbox.id, selectedEmail: { ...open },
      viewingAccountId: changed === 'client' ? 'login-other' : null,
    }));
    await waitFor(() => expect(container.querySelector('[data-mv-conversation-expanded]')?.textContent).toContain('Next sender'));
    const card = container.querySelector('[data-mv-conversation-expanded]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /card.png/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(changed === 'client' ? getThreadB : getThreadA).toHaveBeenLastCalledWith('thread', nextOwner);
    expectBlobRequest(`https://${changed === 'client' ? 'secondary' : 'primary'}.example.com/download/${nextOwner}/same-blob/card.png?accept=image%2Fpng`, changed === 'client' ? 'secondary-login' : 'primary-login');
  });

  it('does not fetch a disconnected stamped source through another login', async () => {
    const { fetchMock } = await conversationClients();
    render(<ConversationEmailBody email={inlineMessage({ sourceClientAccountId: 'disconnected', sourceAccountId: 'nrichmond' })} allowExternal={false} onAllowExternal={() => {}} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates equal email/blob/CID ids across clients and owners and discards late CID results', async () => {
    await conversationClients();
    let finishFirst!: (blob: Blob) => void;
    const firstClient = asClient(primary);
    const secondClient = asClient(other);
    const first = vi.spyOn(firstClient, 'fetchBlob').mockImplementation(() => new Promise(resolve => { finishFirst = resolve; }));
    const second = vi.spyOn(secondClient, 'fetchBlob').mockResolvedValue(new Blob(['second'], { type: 'image/png' }));
    useAuthStore.setState({ client: firstClient as never,
      getClientForAccount: id => (id === 'login-primary' ? firstClient : secondClient) as never,
    });
    const attachments = inlineMessage().attachments;
    const one = inlineMessage({ attachments, sourceClientAccountId: 'login-primary', sourceAccountId: 'owner-a' });
    const two = { ...one, sourceClientAccountId: 'login-other', sourceAccountId: 'owner-b' };
    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:late');
    const body = (email: Email) => <ConversationEmailBody email={email} allowExternal={false} onAllowExternal={() => {}} />;
    const { container, rerender, unmount } = render(body(one));
    await waitFor(() => expect(first).toHaveBeenCalled());
    rerender(body(two));
    await waitFor(() => expect(second).toHaveBeenCalledWith('same-blob', 'card.png', 'image/png', 'owner-b'));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('blob:second'));
    await act(async () => finishFirst(new Blob(['late'], { type: 'image/png' })));
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('blob:second');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
  });

  it('clears resolved CID URLs immediately when only the owning account changes', async () => {
    const { a, fetchMock } = await conversationClients();
    vi.mocked(URL.createObjectURL).mockReturnValue('blob:owner-a');
    const first = inlineMessage({ sourceClientAccountId: 'login-primary', sourceAccountId: 'owner-a' });
    const body = (email: Email) => <ConversationEmailBody email={email} allowExternal={false} onAllowExternal={() => {}} />;
    const { container, rerender } = render(body(first));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('blob:owner-a'));
    vi.spyOn(a, 'fetchBlob').mockImplementation(() => new Promise(() => {}));
    rerender(body({ ...first, sourceAccountId: 'owner-b' }));
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('blob:owner-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.fetchBlob).toHaveBeenLastCalledWith('same-blob', 'card.png', 'image/png', 'owner-b');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owner-a');
  });
});


// Pro hosts must carry the same message-scoped context as MailApp, including
// when the global mail selection is absent or belongs to another message.
type ProBlobAction = 'download' | 'preview click' | 'CID' | 'export';
const proBlobActions: ProBlobAction[] = ['download', 'preview click', 'CID', 'export'];
const proRoutes = [
  { label: 'direct shared folder', secondary: false, owner: 'nrichmond', selection: 'null', unified: false },
  { label: 'secondary shared folder', secondary: true, owner: 'nrichmond', selection: 'unrelated', unified: false },
  { label: 'primary folder', secondary: false, owner: 'postal12345', selection: 'null', unified: false },
  { label: 'secondary primary folder', secondary: true, owner: 'secondary-primary', selection: 'unrelated', unified: false },
  { label: 'Unified tab, null selection', secondary: true, owner: 'nrichmond', selection: 'null', unified: true },
  { label: 'Unified tab, unrelated selection', secondary: true, owner: 'nrichmond', selection: 'unrelated', unified: true },
  { label: 'explicit secondary email tab', secondary: true, owner: 'nrichmond', selection: 'null', unified: false, emailTab: true },
];

async function openProMessage(route: typeof proRoutes[number], action: ProBlobAction) {
  const { a, b, fetchMock } = await conversationClients();
  const origin = route.secondary ? b : a;
  const full = message({
    subject: 'Pro message',
    attachments: [{ ...cardAttachment, name: 'photo.png', ...(action === 'CID' ? { cid: 'test-image' } : {}) }],
    ...(action === 'CID' ? {
      textBody: [], htmlBody: [{ partId: '1', blobId: 'html-blob', type: 'text/html', size: 30 }],
      bodyValues: { '1': { value: '<img src="cid:test-image">', isTruncated: false, isEncodingProblem: false } },
    } : {}),
  });
  const stub = { ...full, sourceClientAccountId: 'login-other', sourceAccountId: route.owner };
  vi.spyOn(a, 'getEmail').mockResolvedValue(full);
  vi.spyOn(b, 'getEmail').mockResolvedValue(full);
  useSettingsStore.setState({ emailDownloadTemplate: '{subject}', mailAttachmentAction: action === 'preview click' ? 'preview' : 'download' });
  useEmailStore.setState({
    emails: route.unified ? [stub] : [],
    selectedEmail: route.selection === 'null' ? null : message({ id: 'unrelated', sourceClientAccountId: 'login-primary', sourceAccountId: 'unrelated-owner' }),
    isUnifiedView: route.unified, selectedMailbox: route.unified ? '__unified_inbox__' : sharedMailbox.id,
    accountMailboxes: { 'login-primary': [primaryMailbox, sharedMailbox], 'login-other': [primaryMailbox, sharedMailbox] },
  });
  if (route.unified || route.emailTab) {
    render(<ProEmailTabBody tabId="reader" data={{ accountId: route.owner, clientAccountId: route.emailTab ? 'login-other' : undefined, emailId: full.id, mailboxId: '__unified_inbox__', title: full.subject! }} />);
  } else {
    const mailbox = route.owner === 'nrichmond' ? sharedMailbox : primaryMailbox;
    vi.spyOn(origin, 'getEmails').mockResolvedValue({ emails: [full], total: 1, hasMore: false });
    render(<ProFolderTabBody tabId="folder" data={{ accountId: route.secondary ? 'login-other' : 'login-primary', mailboxId: mailbox.id, title: mailbox.name }} />);
    fireEvent.click(await screen.findByText('Pro message'));
  }
  if (action === 'CID') await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  else await findAttachmentOpener('photo.png');
  return { a, b, origin, fetchMock, full };
}

async function actOnProBlob(action: ProBlobAction) {
  if (action === 'download') await downloadAttachment();
  if (action === 'preview click') {
    fireEvent.click(await findAttachmentOpener('photo.png'));
    // Preserve Pro's existing action: Preview clicks download, with no modal.
    expect(screen.queryByText('Preview fetch')).not.toBeInTheDocument();
  }
  if (action === 'export') await exportEmail();
}
function expectProBlob(route: typeof proRoutes[number], action: ProBlobAction, index = 0) {
  const host = route.secondary ? 'secondary' : 'primary';
  const blobPath = action === 'export' ? 'raw-blob/Pro%20message.eml?accept=message%2Frfc822' : 'same-blob/photo.png?accept=image%2Fpng';
  expectBlobRequest(`https://${host}.example.com/download/${route.owner}/${blobPath}`, `${host}-login`, index);
}

describe('Pro blob routing', () => {
  it.each(proRoutes.flatMap(route => proBlobActions.map(action => ({ ...route, action }))))(
    '$label: $action uses the message owner and authenticated client', async route => {
      const { origin, fetchMock } = await openProMessage(route, route.action);
      await actOnProBlob(route.action);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expectProBlob(route, route.action);
      if (route.owner === 'nrichmond') expect(origin.getEmail).toHaveBeenCalledWith('email', route.owner);
    },
  );

  it.each([proRoutes[0], proRoutes[1], proRoutes[4]].flatMap(route => proBlobActions.map(action => ({ ...route, action }))))(
    '$label: $action retains its source after account and selection changes', async route => {
      const { a, b, fetchMock } = await openProMessage(route, route.action);
      if (route.action === 'CID') await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // Leave the loaded reader mounted while a different Mail pane navigates.
      act(() => {
        useEmailStore.setState({ emails: [], selectedEmail: message({ id: 'other', sourceClientAccountId: 'login-primary', sourceAccountId: 'unrelated-owner' }), selectedMailbox: 'inbox', isUnifiedView: false });
        useAuthStore.setState({ client: route.secondary ? b : a, activeAccountId: route.secondary ? 'login-other' : 'login-primary' });
      });
      // Switch through null, as reconnecting account switches can do.
      act(() => useAuthStore.setState({ client: null }));
      act(() => useAuthStore.setState({ client: route.secondary ? a : b, activeAccountId: route.secondary ? 'login-primary' : 'login-other' }));
      await act(async () => {});
      await actOnProBlob(route.action);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      for (let index = 0; index < fetchMock.mock.calls.length; index++) expectProBlob(route, route.action, index);
    },
  );

  it('retains an in-flight Unified load across account and selection changes', async () => {
    const { a, b, fetchMock } = await conversationClients();
    let finish!: (email: Email) => void;
    vi.spyOn(b, 'getEmail').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const wrongClient = vi.spyOn(a, 'getEmail');
    useEmailStore.setState({ emails: [message({ sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' })], selectedEmail: null, isUnifiedView: true });
    render(<ProEmailTabBody tabId="reader" data={{ accountId: 'nrichmond', emailId: 'email', mailboxId: null, title: 'Loading' }} />);
    await waitFor(() => expect(b.getEmail).toHaveBeenCalledWith('email', 'nrichmond'));
    act(() => {
      useEmailStore.setState({ emails: [], selectedEmail: message({ id: 'unrelated' }), isUnifiedView: false, selectedMailbox: 'inbox' });
      useAuthStore.setState({ client: b, activeAccountId: 'login-other' });
    });
    await act(async () => finish(message({ attachments: [{ ...cardAttachment, name: 'photo.png' }] })));
    await downloadAttachment();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectProBlob(proRoutes[4], 'download');
    expect(wrongClient).not.toHaveBeenCalled();
    expect(b.getEmail).toHaveBeenCalledTimes(1);
  });

  it('changes CID routing when a reused reader opens identical ids on another client/owner', async () => {
    const { a, b, fetchMock } = await conversationClients();
    const full = inlineMessage({ attachments: [{ ...cardAttachment, name: 'photo.png', cid: 'test-image' }] });
    vi.spyOn(a, 'getEmail').mockResolvedValue(full);
    vi.spyOn(b, 'getEmail').mockResolvedValue({ ...full });
    const reader = (login: string, owner: string) => <ProEmailTabBody tabId="reader" data={{ accountId: owner, clientAccountId: login, emailId: full.id, mailboxId: null, title: full.subject! }} />;
    const { rerender } = render(reader('login-primary', 'owner-a'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectBlobRequest('https://primary.example.com/download/owner-a/same-blob/photo.png?accept=image%2Fpng', 'primary-login');
    rerender(reader('login-other', 'owner-b'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expectBlobRequest('https://secondary.example.com/download/owner-b/same-blob/photo.png?accept=image%2Fpng', 'secondary-login', 1);
  });
});
