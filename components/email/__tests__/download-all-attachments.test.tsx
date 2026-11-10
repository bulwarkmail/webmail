import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import JSZip from 'jszip';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailBlobContext, useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { ToastContainer } from '@/components/ui/toast';
import en from '@/locales/en/common.json';
import { setDownloadGuard } from '@/lib/download-guard';

// Keep the actual viewer handler, translations, JMAP routing/auth/retries and
// JSZip. Stub unrelated viewer hosts, as in the other viewer component tests.
vi.unmock('next-intl');
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  narrowerThan: (px: number) => `(width < ${px / 16}rem)`,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/components/email/external-sender-chip', () => ({ ExternalSenderChip: () => null, useInternalMailDomains: () => [] }));

const { EmailViewer } = await import('../email-viewer');
const initialAuth = useAuthStore.getState();
const initialEmail = useEmailStore.getState();
const initialSettings = useSettingsStore.getState();
const clients: JMAPClient[] = [];
const alpha = new TextEncoder().encode('synthetic alpha\nΚαλημέρα\n');
const beta = new Uint8Array([0, 1, 127, 128, 255, 10]);
const attachments = [
  { partId: '2', blobId: 'blob-a', name: 'report.txt', type: 'application/octet-stream', size: alpha.length },
  { partId: '3', blobId: 'blob-b', name: 'data.bin', type: 'application/octet-stream', size: beta.length },
];
const primaryMailbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const sharedMailbox = { id: 'nrichmond:inbox', originalId: 'inbox', name: 'Shared', isShared: true, accountId: 'nrichmond' } as Mailbox;
const routes = ['primary', 'shared', 'secondary-stamped', 'secondary-folder'] as const;
type Route = typeof routes[number];

function DownloadToasts() {
  const toasts = useToastStore(s => s.toasts);
  return <ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} />;
}

function bytesResponse(bytes: Uint8Array) {
  const buffer = new Uint8Array(bytes).buffer;
  const response = new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream' } });
  // Node's Response returns a Node Blob. JSZip uses the DOM FileReader, so
  // return the identical bytes as a jsdom Blob, as in the drag routing tests.
  response.blob = async () => new Blob([buffer], { type: 'application/octet-stream' });
  return response;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function connect(secondary: boolean) {
  const server = `https://${secondary ? 'secondary' : 'primary'}.example.test`;
  const accountId = secondary ? 'other-primary' : 'postal12345';
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: {
      [accountId]: { name: 'Own', isPersonal: true, accountCapabilities: {} },
      nrichmond: { name: 'Shared', isPersonal: false, accountCapabilities: {} },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId },
    apiUrl: `${server}/api`,
    downloadUrl: `${server}/${secondary ? 'objects' : 'download'}/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${server}/upload/{accountId}`, eventSourceUrl: '',
  }), { status: 200 }));
  const client = secondary
    ? JMAPClient.withBearer(server, 'synthetic-secondary-token', 'secondary-login')
    : new JMAPClient(server, 'primary-login', 'synthetic-password');
  clients.push(client);
  await client.connect();
  return client;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => 'blob:download-all');
  URL.revokeObjectURL = vi.fn();
  useToastStore.getState().clearToasts();
  useSettingsStore.setState({ markAsReadDelay: -1, attachmentImagePreviewsEnabled: false, mailAttachmentAction: 'download' });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.disconnect());
  useAuthStore.setState(initialAuth);
  useEmailStore.setState(initialEmail);
  useSettingsStore.setState(initialSettings);
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openViewer(route: Route = 'secondary-stamped', parts = attachments) {
  const a = await connect(false);
  const b = await connect(true);
  useAuthStore.setState({ client: a, activeAccountId: 'login-primary', identities: [],
    getClientForAccount: id => id === 'login-primary' ? a : id === 'login-other' ? b : undefined,
    getAllConnectedClients: () => new Map([['login-primary', a], ['login-other', b]]),
  });
  const email: Email = {
    id: 'email', threadId: 'thread', blobId: 'raw-blob', subject: 'Download test',
    mailboxIds: {}, keywords: { $seen: true }, size: 100, hasAttachment: true,
    receivedAt: '2026-01-01T00:00:00Z', from: [{ email: 'sender@example.test' }], to: [],
    preview: 'Body', textBody: [{ partId: '1', blobId: 'body-blob', type: 'text/plain', size: 4 }], htmlBody: [],
    bodyValues: { '1': { value: 'Body', isEncodingProblem: false, isTruncated: false } },
    attachments: parts,
    ...(route === 'secondary-stamped' ? { sourceClientAccountId: 'login-other', sourceAccountId: 'nrichmond' } : {}),
  };
  const selectedMailbox = route === 'primary' ? 'inbox' : sharedMailbox.id;
  useEmailStore.setState({ selectedEmail: email, selectedMailbox, isUnifiedView: false,
    viewingAccountId: route === 'secondary-folder' ? 'login-other' : null,
    mailboxes: [primaryMailbox, sharedMailbox], accountMailboxes: { 'login-other': [primaryMailbox, sharedMailbox] },
    searchQuery: '', searchMailboxId: '',
  });
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected network request'));
  const downloadA = vi.spyOn(a, 'downloadBlob');
  const downloadB = vi.spyOn(b, 'downloadBlob');
  const downloads: { href: string; name: string; connected: boolean; notifications: number }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
    downloads.push({ href: this.href, name: this.download, connected: document.body.contains(this),
      notifications: useToastStore.getState().toasts.length });
  });
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <EmailViewer email={email} blobSource={resolveEmailBlobContext(email, a)}
      mailboxes={[primaryMailbox, sharedMailbox]} selectedMailbox={selectedMailbox} />
    <DownloadToasts />
  </NextIntlClientProvider>);
  const button = screen.getAllByTitle('Download all')[0];
  const secondary = route.startsWith('secondary');
  const owner = route === 'primary' ? 'postal12345' : 'nrichmond';
  function assertRequests(blobs: string[]) {
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(blobs.map(id => {
      const name = parts.find(part => part.blobId === id)!.name;
      return `https://${secondary ? 'secondary' : 'primary'}.example.test/${secondary ? 'objects' : 'download'}/${owner}/${id}/${name}?accept=application%2Foctet-stream`;
    }));
    blobs.forEach((_id, i) => {
      expect(fetchMock.mock.calls[i][1]?.headers).toEqual(expect.objectContaining({
        Authorization: secondary ? 'Bearer synthetic-secondary-token' : `Basic ${btoa('primary-login:synthetic-password')}`,
      }));
    });
    expect(downloadA).not.toHaveBeenCalled();
    expect(downloadB).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBe(email);
  }
  function click() {
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button.querySelector('.animate-spin')).not.toBeNull();
  }
  async function finish() {
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 5000 });
    for (const control of screen.getAllByTitle('Download all')) expect(control).toBeEnabled();
    expect(button.querySelector('.animate-spin')).toBeNull();
  }
  async function assertZip(names: string[], contents: Uint8Array[]) {
    // Browser-download initiation only; this does not verify native file creation.
    expect(downloads).toEqual([{ href: 'blob:download-all', name: 'attachments_Download test.zip', connected: true, notifications: 0 }]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await readBlob(blob), { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(names);
    for (let i = 0; i < names.length; i++) {
      expect(Array.from(await zip.file(names[i])!.async('uint8array'))).toEqual(Array.from(contents[i]));
    }
  }
  function success() {
    fetchMock.mockImplementation(async url => bytesResponse(String(url).includes('/blob-a/') ? alpha : beta));
  }
  function noDownload() {
    expect(downloads).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  }
  async function feedback(type: 'warning' | 'error', title: string) {
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type, title })]));
    expect(screen.getByText(title)).toBeVisible();
  }
  async function recover(previousRequests: string[]) {
    act(() => useToastStore.getState().clearToasts());
    success(); click();
    await waitFor(() => expect(downloads).toHaveLength(1));
    await finish();
    assertRequests([...previousRequests, 'blob-a', 'blob-b']);
    expect(useToastStore.getState().toasts).toEqual([]);
    await assertZip(['report.txt', 'data.bin'], [alpha, beta]);
  }
  return { fetchMock, downloads, button, click, finish, assertRequests, assertZip, success, noDownload, feedback, recover };
}

describe('Download all attachments', () => {
  it.each(routes)('downloads exact filenames and bytes through %s routing without feedback', async route => {
    const p = await openViewer(route);
    p.success(); p.click();
    await waitFor(() => expect(p.downloads).toHaveLength(1));
    await p.finish();
    p.assertRequests(['blob-a', 'blob-b']);
    expect(useToastStore.getState().toasts).toEqual([]);
    await p.assertZip(['report.txt', 'data.bin'], [alpha, beta]);
  });

  it('preserves distinct bytes when attachment names collide', async () => {
    const p = await openViewer('shared', attachments.map(part => ({ ...part, name: 'report.txt' })));
    p.success(); p.click();
    await waitFor(() => expect(p.downloads).toHaveLength(1));
    await p.finish();
    p.assertRequests(['blob-a', 'blob-b']);
    expect(useToastStore.getState().toasts).toEqual([]);
    await p.assertZip(['report.txt', 'report (1).txt'], [alpha, beta]);
  });

  it.each([1, 2])('discloses %i omitted attachments once, after initiating the partial ZIP download', async omitted => {
    const parts = omitted === 1 ? attachments : [...attachments, { ...attachments[1], partId: '4', blobId: 'blob-c', name: 'notes.bin' }];
    const p = await openViewer('secondary-stamped', parts);
    p.fetchMock.mockResolvedValueOnce(bytesResponse(alpha)).mockResolvedValueOnce(new Response('refused', { status: 403 }));
    if (omitted === 2) p.fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    p.click();
    await waitFor(() => expect(p.downloads).toHaveLength(1));
    await p.finish();
    p.assertRequests(parts.map(part => part.blobId));
    await p.assertZip(['report.txt'], [alpha]);
    await p.feedback('warning', omitted === 1 ? '1 attachment was omitted from the ZIP.' : '2 attachments were omitted from the ZIP.');
  });

  it('reports total member failure once without an empty ZIP and retries through the same control', async () => {
    const p = await openViewer();
    p.fetchMock.mockResolvedValueOnce(new Response('refused', { status: 403 })).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    p.click(); await p.finish();
    p.assertRequests(['blob-a', 'blob-b']);
    p.noDownload();
    await p.feedback('error', "Couldn't download");
    await p.recover(['blob-a', 'blob-b']);
  });

  it('counts only an exhausted network retry as an omission and makes fresh requests on another attempt', async () => {
    const p = await openViewer();
    p.fetchMock.mockResolvedValueOnce(bytesResponse(alpha))
      .mockRejectedValueOnce(new TypeError('synthetic offline')).mockRejectedValueOnce(new TypeError('synthetic offline'));
    p.click();
    await waitFor(() => expect(p.downloads).toHaveLength(1), { timeout: 5000 });
    await p.finish();
    p.assertRequests(['blob-a', 'blob-b', 'blob-b']);
    await p.assertZip(['report.txt'], [alpha]);
    await p.feedback('warning', '1 attachment was omitted from the ZIP.');
    // Keep the UI/client/message, dismiss the old notification and recover.
    p.downloads.length = 0;
    vi.mocked(URL.createObjectURL).mockClear();
    await p.recover(['blob-a', 'blob-b', 'blob-b']);
  });

  it.each([false, true])('reports ZIP-generation rejection once, including after member failure=%s, and can retry', async partial => {
    const p = await openViewer();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValueOnce(new Error('synthetic ZIP failure'));
    p.fetchMock.mockResolvedValueOnce(bytesResponse(alpha)).mockResolvedValueOnce(partial
      ? new Response('refused', { status: 403 }) : bytesResponse(beta));
    p.click(); await p.finish();
    p.assertRequests(['blob-a', 'blob-b']);
    p.noDownload();
    await p.feedback('error', "Couldn't download");
    expect(diagnostic).toHaveBeenCalledWith('Failed to download attachments:', expect.any(Error));
    // No unhandled-rejection suppression: Vitest must exit successfully.
    await p.recover(['blob-a', 'blob-b']);
  });

  it('does not report a terminal failure when the existing automatic retry recovers', async () => {
    const p = await openViewer();
    p.fetchMock.mockRejectedValueOnce(new TypeError('synthetic transient'))
      .mockResolvedValueOnce(bytesResponse(alpha)).mockResolvedValueOnce(bytesResponse(beta));
    p.click();
    await waitFor(() => expect(p.downloads).toHaveLength(1), { timeout: 5000 });
    await p.finish();
    p.assertRequests(['blob-a', 'blob-a', 'blob-b']);
    expect(useToastStore.getState().toasts).toEqual([]);
    await p.assertZip(['report.txt', 'data.bin'], [alpha, beta]);
  });

  it('keeps the control disabled while fetching and ignores another click', async () => {
    const p = await openViewer();
    let release!: (response: Response) => void;
    p.fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(bytesResponse(beta));
    p.click();
    await waitFor(() => expect(p.fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(p.button);
    expect(p.fetchMock).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([]);
    await act(async () => release(bytesResponse(alpha)));
    await waitFor(() => expect(p.downloads).toHaveLength(1));
    await p.finish();
    p.assertRequests(['blob-a', 'blob-b']);
    await p.assertZip(['report.txt', 'data.bin'], [alpha, beta]);
  });
});

describe('Save all attachments to a folder', () => {
  /** A folder as the picker hands it out; `failOn` makes that file's write fail. */
  function fakeFolder(failOn?: string) {
    const files = new Map<string, Blob | Uint8Array>();
    return {
      files,
      name: 'Downloads',
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!files.has(name) && !options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        return {
          createWritable: async () => ({
            write: async (data: Blob | Uint8Array) => {
              if (name === failOn) throw new Error('Disk full');
              files.set(name, data);
            },
            close: async () => {},
            abort: async () => {},
          }),
        };
      },
      async removeEntry(name: string) { files.delete(name); },
    };
  }

  function stubPicker(result: () => Promise<unknown>) {
    const picker = vi.fn(result);
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker;
    return picker;
  }

  const saveButton = () => screen.getByTestId('attachments-save-to-folder');

  afterEach(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    setDownloadGuard(null);
  });

  it('is not offered where the browser cannot ask for a folder, and the zip stays', async () => {
    await openViewer();
    expect(screen.queryByTestId('attachments-save-to-folder')).toBeNull();
    expect(screen.getAllByTitle('Download all')[0]).toBeVisible();
  });

  it('keeps one row in a narrow pane: with two buttons, just the icons there, and always a name', async () => {
    stubPicker(async () => fakeFolder());
    await openViewer();
    const save = saveButton();
    expect(save.getAttribute('aria-label')).toBe(en.pwaWindows.save_all_to_folder);
    expect(save.querySelector('span')?.className).toContain('hidden @md:inline');
    const download = screen.getAllByTitle('Download all')[0];
    expect(download.getAttribute('aria-label')).toBe('Download all');
    expect(download.querySelector('span')?.className).toContain('hidden @md:inline');
    expect(screen.getAllByTestId('reader-attachments')[0].className).toContain('@container');
  });

  it('shows the zip button as it was where there is only that one', async () => {
    await openViewer();
    const download = screen.getAllByTitle('Download all')[0];
    expect(download.querySelector('span')?.className ?? '').not.toContain('hidden');
    expect(download.textContent).toContain('Download all');
  });

  it('writes each attachment to the folder, names the folder, and starts no zip', async () => {
    const folder = fakeFolder();
    const picker = stubPicker(async () => folder);
    const p = await openViewer();
    p.success();
    fireEvent.click(saveButton());
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'success', title: 'Saved 2 attachments to Downloads.' }),
    ]));
    expect([...folder.files.keys()]).toEqual(['report.txt', 'data.bin']);
    p.noDownload();
  });

  it('asks the device policy before the picker: no save-all when downloads are blocked', async () => {
    const picker = stubPicker(async () => fakeFolder());
    const p = await openViewer();
    setDownloadGuard(() => false);
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(picker).not.toHaveBeenCalled();
    expect(p.fetchMock).not.toHaveBeenCalled();
  });

  it('asks again before each file: a policy turning on stops the rest and says how many went', async () => {
    const folder = fakeFolder();
    stubPicker(async () => folder);
    const p = await openViewer();
    p.success();
    let asked = 0;
    // The click, then the first file's two checks. Off from the second file on.
    setDownloadGuard(() => ++asked <= 3);
    fireEvent.click(saveButton());
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'warning', title: 'Saved 1 of 2 attachments to Downloads.' }),
    ]));
    expect([...folder.files.keys()]).toEqual(['report.txt']);
  });

  it('does nothing when the picker is closed', async () => {
    stubPicker(async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); });
    const p = await openViewer();
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(p.fetchMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
    p.noDownload();
  });

  it('falls back to the zip when the browser refuses the picker', async () => {
    stubPicker(async () => { throw Object.assign(new Error('refused'), { name: 'SecurityError' }); });
    const p = await openViewer();
    p.success();
    fireEvent.click(saveButton());
    await waitFor(() => expect(p.downloads).toHaveLength(1), { timeout: 5000 });
    await p.assertZip(['report.txt', 'data.bin'], [alpha, beta]);
  });

  it('says how many were saved when a write fails midway', async () => {
    const folder = fakeFolder('data.bin');
    stubPicker(async () => folder);
    const p = await openViewer();
    p.success();
    fireEvent.click(saveButton());
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'warning', title: 'Saved 1 of 2 attachments to Downloads.' }),
    ]));
    expect([...folder.files.keys()]).toEqual(['report.txt']);
  });

  it('says so when nothing could be written', async () => {
    const folder = fakeFolder('report.txt');
    stubPicker(async () => folder);
    const p = await openViewer();
    p.success();
    fireEvent.click(saveButton());
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Could not save the attachments to Downloads.' }),
    ]));
  });
});
