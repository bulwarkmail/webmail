import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragEvent } from 'react';
import JSZip from 'jszip';
import { JMAPClient } from '@/lib/jmap/client';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { emailKeyFor, groupEmailsByThread } from '@/lib/thread-utils';
import { ThreadListItem } from '@/components/email/thread-list-item';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/stores/toast-store';
import { useEmailDrag } from '../use-email-drag';

const { startDrag, endDrag } = vi.hoisted(() => ({ startDrag: vi.fn(), endDrag: vi.fn() }));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ startDrag, endDrag, isDragging: false, draggedEmails: [] }),
}));

// Synthetic sessions and message bytes only. Do not mock the JMAP client: URL
// expansion, owner scoping, Basic/Bearer authentication and blob methods are real.
// DataTransfer is mocked; this does not verify native browser/desktop dragging.
const MAIL = 'urn:ietf:params:jmap:mail';
const server = 'https://drag.example.test';
const authA = `Basic ${btoa('a@example.test:synthetic-password')}`;
const authB = 'Bearer synthetic-secondary-token';
const initialAuth = useAuthStore.getState();
const initialEmail = useEmailStore.getState();
const initialSettings = useSettingsStore.getState();
const initialUI = useUIStore.getState();
let clients: Map<string, JMAPClient>;
let liveClients: JMAPClient[];
let objects: Map<string, Blob>;
let requests: { owner: string; blob: string; auth: string }[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let revoke: ReturnType<typeof vi.fn<(url: string) => void>>;

function mail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'same-id', blobId: 'same-blob', threadId: 'same-thread',
    mailboxIds: { inbox: true }, keywords: {}, subject: 'Message',
    receivedAt: '2026-10-01T00:00:00Z', size: 1, hasAttachment: false,
    ...overrides,
  } as Email;
}

function shared(owner: string): Mailbox {
  return { id: `${owner}:inbox`, originalId: 'inbox', name: 'Shared', isShared: true, accountId: owner } as Mailbox;
}

function browse(owner: string, login?: string) {
  const mailbox = shared(owner);
  act(() => useEmailStore.setState({
    viewingAccountId: login ?? null, selectedMailbox: mailbox.id,
    mailboxes: [mailbox], accountMailboxes: login ? { [login]: [mailbox] } : {},
  }));
}

function bytes(owner: string, auth: string, blob = 'same-blob') {
  return `From: synthetic@example.test\r\nSubject: ${owner}\r\n\r\n${auth}\r\n${blob}\r\n`;
}

function blobResponse(content: string): Response {
  const response = new Response(content, { headers: { 'Content-Type': 'message/rfc822' } });
  // jsdom's FileReader and JSZip need a jsdom Blob, rather than Node's Blob.
  response.blob = async () => new Blob([content], { type: 'message/rfc822' });
  return response;
}

async function connect(login: string, primary: string, bearer = false): Promise<JMAPClient> {
  const client = bearer
    ? JMAPClient.withBearer(server, 'synthetic-secondary-token', 'b@example.test')
    : new JMAPClient(server, 'a@example.test', 'synthetic-password');
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    capabilities: { 'urn:ietf:params:jmap:core': {}, [MAIL]: {} },
    accounts: { [primary]: { name: primary, isPersonal: true, accountCapabilities: { [MAIL]: {} } } },
    primaryAccounts: { [MAIL]: primary }, apiUrl: `${server}/api`,
    downloadUrl: `${server}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${server}/upload/{accountId}`, eventSourceUrl: `${server}/events`,
  }), { headers: { 'Content-Type': 'application/json' } }));
  await client.connect();
  clients.set(login, client);
  liveClients.push(client);
  return client;
}

function drag(handlers: ReturnType<typeof useEmailDrag>['dragHandlers']) {
  const payload = new Map<string, string>();
  const dataTransfer = {
    setData: (type: string, value: string) => payload.set(type, value),
    setDragImage: vi.fn(), effectAllowed: '',
  };
  act(() => handlers.onDragStart({ dataTransfer } as unknown as DragEvent<HTMLDivElement>));
  return payload;
}

function payloadBlob(payload: Map<string, string>) {
  const value = payload.get('DownloadURL');
  expect(value).toBeDefined();
  const url = value!.slice(value!.indexOf('blob:'));
  expect(objects.has(url)).toBe(true);
  return objects.get(url)!;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function text(blob: Blob) {
  return new TextDecoder().decode(await readBlob(blob));
}

async function warm(result: { current: ReturnType<typeof useEmailDrag> }) {
  act(() => result.current.dragHandlers.onPointerEnter?.());
  await waitFor(() => expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(true), { container: document.createElement('div') });
  return drag(result.current.dragHandlers);
}

function select(emails: Email[]) {
  useEmailStore.setState({ emails, selectedEmailKeys: new Set(emails.map(emailKeyFor)), isUnifiedView: true });
}

beforeEach(async () => {
  clients = new Map();
  liveClients = [];
  objects = new Map();
  requests = [];
  startDrag.mockClear();
  endDrag.mockClear();
  vi.spyOn(toast, 'error').mockImplementation(() => '');
  revoke = vi.fn<(url: string) => void>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:synthetic-${objects.size}`;
    objects.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/130.0');
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const [, route, owner, blob] = url.pathname.split('/').map(decodeURIComponent);
    // No real network fallback, including for a bad route.
    if (url.origin !== server || route !== 'download') throw new Error(`Unexpected synthetic request: ${url}`);
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    requests.push({ owner, blob, auth });
    return blobResponse(bytes(owner, auth, blob));
  });
  vi.stubGlobal('fetch', fetchMock);
  const primary = await connect('login-a', 'primary-a');
  await connect('login-b', 'primary-b', true);
  useAuthStore.setState({
    client: primary, activeAccountId: 'login-a',
    getClientForAccount: (id) => clients.get(id),
  });
  useEmailStore.setState({
    ...initialEmail, emails: [], selectedEmailKeys: new Set(), threadEmailsCache: new Map(),
    selectedMailbox: 'inbox', viewingAccountId: null, mailboxes: [], accountMailboxes: {},
    searchQuery: '', isUnifiedView: false,
  });
  useUIStore.setState({ isMobile: false });
  useSettingsStore.setState({ emailDownloadTemplate: '{subject}', bundleDownloadTemplate: 'emails-{count}' });
});

afterEach(() => {
  cleanup();
  for (const client of liveClients) client.disconnect();
  useAuthStore.setState(initialAuth);
  useEmailStore.setState(initialEmail);
  useSettingsStore.setState(initialSettings);
  useUIStore.setState(initialUI);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('message drag blob routing', () => {
  it('keeps primary-account routing, filenames and drag payloads compatible', async () => {
    const email = mail({ subject: 'Hello world' });
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    const payload = await warm(result);
    expect(requests).toEqual([{ owner: 'primary-a', blob: 'same-blob', auth: authA }]);
    expect(await text(payloadBlob(payload))).toBe(bytes('primary-a', authA));
    expect(payload.get('DownloadURL')).toMatch(/^message\/rfc822:Hello world.eml:blob:/);
    expect(payload.get('application/x-email-ids')).toBe('["same-id"]');
    expect(payload.get('text/plain')).toBe('Hello world');
    expect(payload.get('text/uri-list')).toContain('/mail/message/same-id?view=fullscreen');
    expect(startDrag).toHaveBeenLastCalledWith([email], 'inbox');
  });

  it.each([undefined, 'login-b'])('routes a direct shared-folder single message through %s', async (login) => {
    browse('shared owner', login);
    const { result } = renderHook(() => useEmailDrag({ email: mail(), sourceMailboxId: 'shared owner:inbox' }));
    const payload = await warm(result);
    const auth = login ? authB : authA;
    expect(requests).toEqual([{ owner: 'shared owner', blob: 'same-blob', auth }]);
    expect(await text(payloadBlob(payload))).toBe(bytes('shared owner', auth));
  });

  it('honors a shared message source through a secondary login even outside Unified', async () => {
    const email = mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b', accountId: 'display-only' });
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    expect(await text(payloadBlob(await warm(result)))).toBe(bytes('shared-b', authB));
    expect(requests).toEqual([{ owner: 'shared-b', blob: 'same-blob', auth: authB }]);
  });

  it('never substitutes the active client for a disconnected source login', async () => {
    clients.delete('login-b');
    const email = mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    act(() => result.current.dragHandlers.onPointerEnter?.());
    await act(async () => { await Promise.resolve(); });
    expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(false);
    expect(requests).toEqual([]);
  });

  it('routes every ZIP entry independently despite colliding email/blob IDs and filenames', async () => {
    const emails = [
      mail({ sourceClientAccountId: 'login-a', sourceAccountId: 'primary-a' }),
      mail({ sourceClientAccountId: 'login-a', sourceAccountId: 'shared-a' }),
      mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'primary-b' }),
      mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' }),
    ];
    select(emails);
    const { result } = renderHook(() => useEmailDrag({ email: emails[0], sourceMailboxId: '__unified_inbox__' }));
    const payload = await warm(result);
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(payload)));
    expect(Object.keys(zip.files)).toHaveLength(4);
    expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
      .toEqual([bytes('primary-a', authA), bytes('shared-a', authA), bytes('primary-b', authB), bytes('shared-b', authB)]);
    expect(requests).toEqual([
      { owner: 'primary-a', blob: 'same-blob', auth: authA },
      { owner: 'shared-a', blob: 'same-blob', auth: authA },
      { owner: 'primary-b', blob: 'same-blob', auth: authB },
      { owner: 'shared-b', blob: 'same-blob', auth: authB },
    ]);
    expect(payload.get('DownloadURL')).toMatch(/^application\/zip:emails-4.zip:blob:/);
    expect(payload.get('application/x-email-ids')).toBe(JSON.stringify(emails.map((email) => email.id)));
    expect(startDrag).toHaveBeenLastCalledWith(emails, '__unified_inbox__');
  });

  it('selects by account-aware identity without including an unselected namesake', async () => {
    const own = mail({ sourceClientAccountId: 'login-a', sourceAccountId: 'primary-a' });
    const other = mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    useEmailStore.setState({ emails: [own, other], selectedEmailKeys: new Set([emailKeyFor(other)]) });
    const { result } = renderHook(() => useEmailDrag({ email: other, sourceMailboxId: 'inbox' }));
    expect(await text(payloadBlob(await warm(result)))).toBe(bytes('shared-b', authB));
    expect(startDrag).toHaveBeenLastCalledWith([other], 'inbox');
    expect(requests).toHaveLength(1);
  });

  it('includes selected expanded-thread members outside the visible list', async () => {
    const row = mail({ id: 'row', sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    const member = mail({ id: 'expanded', blobId: 'expanded-blob', sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    useEmailStore.setState({ emails: [row], threadEmailsCache: new Map([['thread', [row, member]]]), selectedEmailKeys: new Set([emailKeyFor(row), emailKeyFor(member)]) });
    const { result } = renderHook(() => useEmailDrag({ email: row, sourceMailboxId: 'inbox' }));
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(await warm(result))));
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
      .toEqual([bytes('shared-b', authB), bytes('shared-b', authB, 'expanded-blob')]);
    expect(startDrag).toHaveBeenLastCalledWith([row, member], 'inbox');
  });

  it('keeps explicit thread-header members and routes their ZIP', async () => {
    const threadEmails = [mail({ id: 'one', sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' }), mail({ id: 'two', blobId: 'two-blob', sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' })];
    const { result } = renderHook(() => useEmailDrag({ email: threadEmails[0], threadEmails, sourceMailboxId: 'inbox' }));
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(await warm(result))));
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(requests.every(({ owner, auth }) => owner === 'shared-b' && auth === authB)).toBe(true);
    expect(startDrag).toHaveBeenLastCalledWith(threadEmails, 'inbox');
  });

  it.each(['owner', 'client', 'blob', 'message', 'replacement client'] as const)('does not reuse a single prefetch after changing %s', async (change) => {
    browse('owner-one');
    const { result, rerender } = renderHook(({ email }) => useEmailDrag({ email, sourceMailboxId: 'inbox' }), { initialProps: { email: mail() } });
    const old = await warm(result);
    let email = mail();
    if (change === 'owner') browse('owner-two');
    if (change === 'client') act(() => useAuthStore.setState({ client: clients.get('login-b'), activeAccountId: 'login-b' }));
    if (change === 'blob') email = mail({ blobId: 'new-blob' });
    if (change === 'message') email = mail({ id: 'new-id' });
    if (change === 'replacement client') {
      const replacement = await connect('login-a', 'replacement-primary');
      act(() => useAuthStore.setState({ client: replacement }));
    }
    rerender({ email });
    expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(false);
    const next = await warm(result);
    expect(next.get('DownloadURL')).not.toBe(old.get('DownloadURL'));
    expect(requests).toHaveLength(2);
    expect(await text(payloadBlob(next))).toBe(bytes(change === 'owner' ? 'owner-two' : 'owner-one', change === 'client' ? authB : authA, email.blobId));
  });

  it('shares a bundle between rows but rebuilds for a new owner with the same raw IDs', async () => {
    const emails = [mail({ id: 'one' }), mail({ id: 'two' })];
    browse('owner-one');
    select(emails);
    const first = renderHook(() => useEmailDrag({ email: emails[0], sourceMailboxId: 'inbox' }));
    const second = renderHook(() => useEmailDrag({ email: emails[1], sourceMailboxId: 'inbox' }));
    const old = await warm(first.result);
    expect((await warm(second.result)).get('DownloadURL')).toBe(old.get('DownloadURL'));
    expect(requests).toHaveLength(2);
    browse('owner-two', 'login-b');
    expect(drag(first.result.current.dragHandlers).has('DownloadURL')).toBe(false);
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(await warm(first.result))));
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
      .toEqual([bytes('owner-two', authB), bytes('owner-two', authB)]);
    expect(requests).toHaveLength(4);
  });

  it('discards a late single prefetch after a context switch and revokes it after the grace period', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ email }) => useEmailDrag({ email, sourceMailboxId: 'inbox' }), { initialProps: { email: mail({ sourceClientAccountId: 'login-a', sourceAccountId: 'primary-a' }) } });
    act(() => result.current.dragHandlers.onPointerEnter?.());
    rerender({ email: mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' }) });
    const next = await warm(result);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { finish(blobResponse('stale bytes')); });
    expect(objects.size).toBe(2);
    expect(await text(payloadBlob(drag(result.current.dragHandlers)))).toBe(bytes('shared-b', authB));
    expect(drag(result.current.dragHandlers).get('DownloadURL')).toBe(next.get('DownloadURL'));
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith(next.get('DownloadURL')!.split(':').slice(2).join(':'));
    expect(revoke).toHaveBeenCalledWith([...objects.keys()][1]);
  });

  it('revokes a single prefetch that finishes after unmount', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useEmailDrag({ email: mail(), sourceMailboxId: 'inbox' }));
    act(() => result.current.dragHandlers.onPointerEnter?.());
    unmount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { finish(blobResponse('unmounted bytes')); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith([...objects.keys()][0]);
  });

  it.each(['client', 'blob', 'replacement client'] as const)('rebuilds a ZIP after changing %s while raw message IDs stay the same', async (change) => {
    const emails = [mail({ id: 'one' }), mail({ id: 'two' })];
    browse('same-owner');
    select(emails);
    const { result } = renderHook(() => useEmailDrag({ email: emails[0], sourceMailboxId: 'inbox' }));
    const old = await warm(result);
    const owner = 'same-owner';
    let auth = authA;
    if (change === 'client') {
      act(() => useAuthStore.setState({ client: clients.get('login-b'), activeAccountId: 'login-b' }));
      auth = authB;
    } else if (change === 'replacement client') {
      const replacement = await connect('login-a', 'replacement-primary');
      act(() => useAuthStore.setState({ client: replacement }));
    } else {
      act(() => select(emails.map((email) => ({ ...email, blobId: 'new-blob' }))));
    }
    expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(false);
    const next = await warm(result);
    expect(next.get('DownloadURL')).not.toBe(old.get('DownloadURL'));
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(next)));
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
      .toEqual([bytes(owner, auth, change === 'blob' ? 'new-blob' : 'same-blob'), bytes(owner, auth, change === 'blob' ? 'new-blob' : 'same-blob')]);
    expect(requests).toHaveLength(4);
  });

  it('retires a late ZIP build without replacing the current context bundle', async () => {
    const emails = [mail({ id: 'one' }), mail({ id: 'two' })];
    select(emails);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useEmailDrag({ email: emails[0], sourceMailboxId: 'inbox' }));
    act(() => result.current.dragHandlers.onPointerEnter?.());
    await waitFor(() => expect(finish).toBeDefined());
    browse('next-owner', 'login-b');
    const next = await warm(result);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { finish(blobResponse('obsolete ZIP entry')); });
    // JSZip uses setImmediate internally; wait for the obsolete build to finish.
    await vi.waitFor(() => expect(objects.size).toBe(2));
    expect(drag(result.current.dragHandlers).get('DownloadURL')).toBe(next.get('DownloadURL'));
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith([...objects.keys()][1]);
  });

  it('keeps a pending cold-drag prefetch across dragend and publishes only on the synchronous retry', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const email = mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    const initialFetches = fetchMock.mock.calls.length;
    const coldPayload = drag(result.current.dragHandlers);
    expect(coldPayload.has('DownloadURL')).toBe(false);
    expect(startDrag).toHaveBeenLastCalledWith([email], 'inbox');
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    expect(endDrag).toHaveBeenCalledTimes(1);
    await act(async () => { finish(blobResponse(bytes('shared-b', authB))); });
    expect(objects.size).toBe(1);
    // A completed request must never mutate an earlier drag's DataTransfer.
    expect(coldPayload.has('DownloadURL')).toBe(false);
    const retry = drag(result.current.dragHandlers);
    expect(retry.get('DownloadURL')).toMatch(/^message\/rfc822:Message.eml:blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(initialFetches + 1);
    expect(await text(payloadBlob(retry))).toBe(bytes('shared-b', authB));
    expect(revoke).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledWith([...objects.keys()][0]);
  });

  it.each(['owner', 'login', 'message', 'blob'] as const)('rejects a pending cold-drag result after changing %s', async (change) => {
    browse('owner-one');
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ email }) => useEmailDrag({ email, sourceMailboxId: 'inbox' }), { initialProps: { email: mail() } });
    const coldPayload = drag(result.current.dragHandlers);
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    if (change === 'owner') browse('owner-two');
    if (change === 'login') browse('owner-one', 'login-b');
    if (change === 'message') rerender({ email: mail({ id: 'next-message' }) });
    if (change === 'blob') rerender({ email: mail({ blobId: 'next-blob' }) });
    await act(async () => { finish(blobResponse('obsolete bytes')); });
    expect(coldPayload.has('DownloadURL')).toBe(false);
    expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(false);
    const expectedOwner = change === 'owner' ? 'owner-two' : 'owner-one';
    const expectedAuth = change === 'login' ? authB : authA;
    const next = await warm(result);
    expect(await text(payloadBlob(next))).toBe(bytes(expectedOwner, expectedAuth, change === 'blob' ? 'next-blob' : 'same-blob'));
    expect(next.get('DownloadURL')).not.toContain([...objects.keys()][0]);
  });

  it('retires a pending cold-drag result when its row unmounts after dragend', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useEmailDrag({ email: mail(), sourceMailboxId: 'inbox' }));
    const payload = drag(result.current.dragHandlers);
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    unmount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { finish(blobResponse('retired bytes')); });
    expect(payload.has('DownloadURL')).toBe(false);
    expect(objects.size).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledWith([...objects.keys()][0]);
  });

  it('keeps drag-out disabled on mobile and unsupported browsers', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Firefox/130.0');
    const { result, rerender } = renderHook(() => useEmailDrag({ email: mail(), sourceMailboxId: 'inbox' }));
    expect(result.current.dragHandlers.onPointerEnter).toBeUndefined();
    expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(false);
    act(() => useUIStore.setState({ isMobile: true }));
    rerender();
    expect(result.current.dragHandlers.draggable).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe('ZIP failure handling and retry', () => {
  function pair() {
    return [mail({ id: 'one', blobId: 'one-blob' }), mail({ id: 'two', blobId: 'two-blob' })];
  }

  function mount(emails = pair()) {
    select(emails);
    return renderHook(() => useEmailDrag({ email: emails[0], sourceMailboxId: 'inbox' }));
  }

  async function expectComplete(payload: Map<string, string>, owner = 'primary-a', auth = authA) {
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(payload)));
    expect(Object.keys(zip.files).sort()).toEqual(['Message [two].eml', 'Message.eml']);
    expect(await zip.file('Message.eml')!.async('string')).toBe(bytes(owner, auth, 'one-blob'));
    expect(await zip.file('Message [two].eml')!.async('string')).toBe(bytes(owner, auth, 'two-blob'));
  }

  it.each([1, 2])('publishes no partial or empty ZIP when %i members fail', async (failures) => {
    fetchMock.mockResolvedValueOnce(failures === 1 ? blobResponse('OK') : new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const generation = vi.spyOn(JSZip.prototype, 'generateAsync');
    const { result } = mount();
    const payload = drag(result.current.dragHandlers);
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('export_email_error'));
    expect(objects.size).toBe(0);
    expect(generation).not.toHaveBeenCalled();
    expect(payload.has('DownloadURL')).toBe(false);
    expect(payload.get('application/x-email-ids')).toBe('["one","two"]');
    expect(startDrag).toHaveBeenLastCalledWith(pair(), 'inbox');
  });

  it.each(['missing blob', 'all missing blobs', 'unavailable client', 'all unavailable clients'])('rejects the entire selection for %s', async (reason) => {
    const emails = pair().map((email, index) => index === 1 || reason.startsWith('all')
      ? { ...email, ...(reason.includes('blob') ? { blobId: undefined } : { sourceClientAccountId: 'offline', sourceAccountId: 'shared-offline' }) }
      : email);
    const { result } = mount(emails);
    const calls = fetchMock.mock.calls.length;
    const payload = drag(result.current.dragHandlers);
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('export_email_error'));
    expect(objects.size).toBe(0);
    expect(payload.has('DownloadURL')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(calls); // Validate before fetching any member.
  });

  it.each(['insertion', 'generation', 'object URL'])('retries after %s failure and includes every message', async (stage) => {
    if (stage === 'insertion') vi.spyOn(JSZip.prototype, 'file').mockImplementationOnce(() => { throw new Error('synthetic insertion failure'); });
    if (stage === 'generation') vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValueOnce(new Error('synthetic generation failure'));
    if (stage === 'object URL') vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error('synthetic object URL failure'); });
    const { result } = mount();
    const calls = fetchMock.mock.calls.length;
    const failed = drag(result.current.dragHandlers);
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('export_email_error'));
    expect(objects.size).toBe(0);
    expect(failed.has('DownloadURL')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 2);
    const recovered = await warm(result);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 4);
    await expectComplete(recovered);
    expect(failed.has('DownloadURL')).toBe(false); // Never mutate a past DataTransfer.
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('refetches the unchanged selection after %i transient member failures', async (failures) => {
    fetchMock.mockResolvedValueOnce(failures === 1 ? blobResponse('OK') : new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { result, unmount } = mount();
    const calls = fetchMock.mock.calls.length;
    const failed = drag(result.current.dragHandlers);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(objects.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 2);
    act(() => result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    unmount();
    const retry = mount();
    act(() => retry.result.current.dragHandlers.onPointerEnter?.());
    await waitFor(() => expect(objects.size).toBe(1));
    expect(failed.has('DownloadURL')).toBe(false);
    await expectComplete(drag(retry.result.current.dragHandlers));
    expect(fetchMock).toHaveBeenCalledTimes(calls + 4);
    // A complete bundle remains cached across another dragend and row.
    act(() => retry.result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    const other = renderHook(() => useEmailDrag({ email: pair()[1], sourceMailboxId: 'inbox' }));
    await expectComplete(await warm(other.result));
    expect(fetchMock).toHaveBeenCalledTimes(calls + 4);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it.each(['hover', 'drag'])('deduplicates a shared %s build and reports its failure once after rows drag', async (origin) => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const emails = pair();
    const first = mount(emails);
    const second = renderHook(() => useEmailDrag({ email: emails[1], sourceMailboxId: 'inbox' }));
    const calls = fetchMock.mock.calls.length;
    if (origin === 'hover') {
      act(() => first.result.current.dragHandlers.onPointerEnter?.());
      act(() => second.result.current.dragHandlers.onPointerEnter?.());
    }
    const firstPayload = drag(first.result.current.dragHandlers);
    const secondPayload = drag(second.result.current.dragHandlers);
    await waitFor(() => expect(finish).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(calls + 2);
    expect(toast.error).not.toHaveBeenCalled();
    act(() => first.result.current.dragHandlers.onDragEnd({} as DragEvent<HTMLDivElement>));
    await act(async () => { finish(new Response(null, { status: 503 })); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('export_email_error'));
    expect(objects.size).toBe(0);
    expect(firstPayload.has('DownloadURL')).toBe(false);
    expect(secondPayload.has('DownloadURL')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 2); // No automatic retry.
  });

  it('keeps repeated passive hover failures silent and reports only a failed drag attempt', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const { result } = mount();
    const calls = fetchMock.mock.calls.length;
    for (let attempt = 1; attempt <= 3; attempt++) {
      act(() => result.current.dragHandlers.onPointerEnter?.());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls + 2 * attempt));
      await act(async () => { await Promise.resolve(); });
      expect(toast.error).not.toHaveBeenCalled();
      expect(objects.size).toBe(0);
    }
    drag(result.current.dragHandlers);
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('export_email_error'));
    expect(fetchMock).toHaveBeenCalledTimes(calls + 8);
  });

  it('retries a failed hover on drag without notifying when that attempt succeeds', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { result } = mount();
    const calls = fetchMock.mock.calls.length;
    act(() => result.current.dragHandlers.onPointerEnter?.());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls + 2));
    await act(async () => { await Promise.resolve(); });
    expect(toast.error).not.toHaveBeenCalled();
    const cold = drag(result.current.dragHandlers);
    expect(cold.has('DownloadURL')).toBe(false);
    await waitFor(() => expect(objects.size).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(calls + 4);
    expect(cold.has('DownloadURL')).toBe(false);
    await expectComplete(drag(result.current.dragHandlers));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['pending', 'ready'])('does not let an old failure clear or notify over a newer %s bundle', async (status) => {
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const { result } = mount();
    drag(result.current.dragHandlers);
    await waitFor(() => expect(finishOld).toBeDefined());
    browse('next-owner', 'login-b');
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    drag(result.current.dragHandlers);
    await waitFor(() => expect(finishNew).toBeDefined());
    const calls = fetchMock.mock.calls.length;
    if (status === 'ready') {
      await act(async () => { finishNew(blobResponse(bytes('next-owner', authB, 'one-blob'))); });
      await waitFor(() => expect(objects.size).toBe(1));
    }
    await act(async () => { finishOld(new Response(null, { status: 503 })); });
    expect(toast.error).not.toHaveBeenCalled();
    const payload = drag(result.current.dragHandlers);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    if (status === 'pending') {
      expect(payload.has('DownloadURL')).toBe(false);
      await act(async () => { finishNew(blobResponse(bytes('next-owner', authB, 'one-blob'))); });
    }
    await expectComplete(await warm(result), 'next-owner', authB);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// Render the actual row component and real drag/JMAP hooks. Only DataTransfer
// and the network are synthetic; do not call the hook's pointer handler here.
describe('message row drag hover wiring', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'split', density: 'regular', hoverActions: ['delete'] });
    useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
  });

  function renderRows(emails: Email[]) {
    const [thread] = groupEmailsByThread(emails);
    const onDelete = vi.fn();
    const ui = render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onDelete={onDelete} />);
    const row = emails.length === 1
      ? ui.getByTestId('email-list-item')
      : ui.getByText('Message').closest('[draggable]') as HTMLElement;
    expect(row).not.toBeNull();
    return { ...ui, row, onDelete };
  }

  function rowDrag(row: HTMLElement) {
    const payload = new Map<string, string>();
    const dataTransfer = { effectAllowed: '', setDragImage: vi.fn(), setData: vi.fn((type: string, value: string) => payload.set(type, value)) };
    fireEvent.dragStart(row, { dataTransfer });
    return { payload, dataTransfer };
  }

  it.each(['single message', 'thread header'] as const)('prefetches on real %s pointer entry while retaining working hover actions', async (kind) => {
    const stamp = { sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' };
    const emails = kind === 'single message'
      ? [mail(stamp)]
      : [mail({ ...stamp, id: 'one' }), mail({ ...stamp, id: 'two', blobId: 'two-blob' })];
    useEmailStore.setState({ emails });
    const { row, onDelete } = renderRows(emails);
    expect(within(row).queryByTestId('hover-action-delete')).toBeNull();
    fireEvent.pointerEnter(row);
    const button = within(row).getByTestId('hover-action-delete');
    expect(button).toBeInTheDocument();
    // Wait for bytes without starting a drag: this must be hover prefetch.
    await waitFor(() => expect(objects.size).toBe(1));
    const { payload, dataTransfer } = rowDrag(row);
    expect(payload.has('DownloadURL')).toBe(true); // synchronous dragstart
    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(startDrag).toHaveBeenLastCalledWith(expect.arrayContaining(emails), 'inbox');
    if (kind === 'single message') {
      expect(await text(payloadBlob(payload))).toBe(bytes('shared-b', authB));
    } else {
      const zip = await JSZip.loadAsync(await readBlob(payloadBlob(payload)));
      expect(Object.keys(zip.files)).toHaveLength(2);
      expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
        .toEqual([bytes('shared-b', authB), bytes('shared-b', authB, 'two-blob')]);
    }
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('prefetches the account-aware mixed-owner selection from a real single row', async () => {
    const emails = [
      mail({ sourceClientAccountId: 'login-a', sourceAccountId: 'primary-a' }),
      mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' }),
    ];
    select(emails);
    const { row } = renderRows([emails[0]]);
    fireEvent.pointerEnter(row);
    await waitFor(() => expect(objects.size).toBe(1));
    const { payload } = rowDrag(row);
    expect(payload.get('application/x-email-ids')).toBe(JSON.stringify(emails.map((email) => email.id)));
    const zip = await JSZip.loadAsync(await readBlob(payloadBlob(payload)));
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(await Promise.all(Object.values(zip.files).map((entry) => entry.async('string'))))
      .toEqual([bytes('primary-a', authA), bytes('shared-b', authB)]);
    expect(startDrag).toHaveBeenLastCalledWith(emails, 'inbox');
  });

  it('warms a real cold row across dragend without writing its first payload asynchronously', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const email = mail({ sourceClientAccountId: 'login-b', sourceAccountId: 'shared-b' });
    const { row } = renderRows([email]);
    const cold = rowDrag(row);
    expect(cold.payload.has('DownloadURL')).toBe(false);
    const writesAtStart = cold.dataTransfer.setData.mock.calls.length;
    fireEvent.dragEnd(row);
    await act(async () => { finish(blobResponse(bytes('shared-b', authB))); });
    expect(cold.dataTransfer.setData).toHaveBeenCalledTimes(writesAtStart);
    const retry = rowDrag(row);
    expect(retry.payload.get('DownloadURL')).toMatch(/^message\/rfc822:Message.eml:blob:/);
    expect(await text(payloadBlob(retry.payload))).toBe(bytes('shared-b', authB));
  });

  it("in the desktop app an Alt drag is the OS's own with the real bytes, and a plain one stays the page's", async () => {
    const email = mail({ subject: 'Hello world' });
    const nativeDrag = vi.fn(async (_files: { name: string; data: Uint8Array }[]) => true);
    window.bulwarkDesktop = { version: 1, platform: 'win32', os: { startDrag: nativeDrag } } as never;
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    await warm(result);
    try {
      startDrag.mockClear();
      // Plain: still a move to a folder, still DownloadURL for Explorer.
      expect(drag(result.current.dragHandlers).has('DownloadURL')).toBe(true);
      expect(startDrag).toHaveBeenCalled();
      expect(nativeDrag).not.toHaveBeenCalled();

      startDrag.mockClear();
      const preventDefault = vi.fn();
      const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' };
      act(() => result.current.dragHandlers.onDragStart({ altKey: true, preventDefault, dataTransfer } as unknown as DragEvent<HTMLDivElement>));
      expect(preventDefault).toHaveBeenCalled();
      expect(startDrag).not.toHaveBeenCalled();
      await waitFor(() => expect(nativeDrag).toHaveBeenCalled(), { container: document.createElement('div') });
      const [files] = nativeDrag.mock.calls[0];
      expect(files[0].name).toBe('Hello world.eml');
      expect(new TextDecoder().decode(files[0].data)).toBe(bytes('primary-a', authA));
    } finally {
      window.bulwarkDesktop = undefined;
    }
  });
});
