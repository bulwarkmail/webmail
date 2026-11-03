import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { setStoreBackend } from '@/lib/store/client/api';
import { FakeJmapDrafts } from '@/lib/store/__tests__/helpers/fake-drafts';
import { JMAP_ACCOUNT } from '@/lib/store/__tests__/helpers/fake-jmap';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { consumeLost } from '../lost';
import { offlineNotify, refreshQueueState, setOfflineNotifier, startOfflineMode, unsentCount, wipeAccount, wipeEverything } from '../offline-mode';
import { flushQueue, forgetOrphanCheck } from '../flush';
import { heldFile, holdFile, noteDraftReplacedElsewhere, queueSend, readLocalDrafts, retryLocalDraft } from '../queue';
import { forgetLegacyMove } from '../migrate-legacy';
import { useOfflineStore, writeEnabled } from '../state';
import type { JMAPClient } from '@/lib/jmap/client';

let server: FakeJmapDrafts;
let store: InProcessStore;

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => 'https://mail.example.org',
    getUsername: () => 'alice@example.org',
    getAccountId: () => JMAP_ACCOUNT,
    isOfflineOnly: () => false,
    getSessionSnapshot: () => null,
    getAuthHeader: () => 'Basic x',
    keywordSortInverted: () => null,
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' })),
    uploadBlob: vi.fn(async (file: File) => server.upload(JMAP_ACCOUNT, new Uint8Array(await file.arrayBuffer()))),
    requestNetworkOnly: vi.fn((calls: never) => server.request(calls)),
    resolveSendAccountId: vi.fn(async () => JMAP_ACCOUNT),
    submissionAccountFor: () => JMAP_ACCOUNT,
    pruneEmailSubmissions: vi.fn(async () => {}),
    ...overrides,
  };
}

let stop: () => void = () => {};

async function saveOffline(subject: string, attachments?: Array<Record<string, unknown>>): Promise<string> {
  const answer = await store.answer('acc', [['Email/set', {
    accountId: JMAP_ACCOUNT,
    create: {
      c: {
        messageId: [`${subject}@example.org`],
        subject,
        keywords: { $seen: true, $draft: true },
        mailboxIds: { drafts: true },
        bodyValues: { 1: { value: 'text' } },
        textBody: [{ partId: '1' }],
        ...(attachments ? { attachments } : {}),
      },
    },
  }, 's']]);
  return answer?.methodResponses[0][1].created.c.id as string;
}

beforeEach(async () => {
  server = new FakeJmapDrafts({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] });
  server.now = Date.now();
  store = new InProcessStore(server);
  setStoreBackend(store);
  forgetLegacyMove();
  forgetOrphanCheck();
  localStorage.clear();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, conflicts: [], localDrafts: [], browserOffline: false, downServers: [], startedOffline: false });
  usePolicyStore.setState({ loaded: true, subject: { email: 'alice@example.org', groups: [] }, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
  const client = fakeClient();
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
  writeEnabled(['acc']);
  stop = startOfflineMode();
  await store.sync('acc');
});

afterEach(async () => {
  stop();
  await wipeEverything();
  setStoreBackend(null);
});

describe('flushQueue and drafts', () => {
  it('uploads a draft\'s files, creates it, tells the page, and leaves nothing behind', async () => {
    const client = fakeClient();
    const held = await holdFile('acc', new File(['hello'], 'note.txt', { type: 'text/plain' }), 'note.txt');
    await saveOffline('With a file', [{ blobId: held.blobId, type: 'text/plain', name: 'note.txt' }]);
    const onDraftSent = vi.fn();
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, onDraftSent });
    expect(server.drafts().map((email) => email.subject)).toEqual(['With a file']);
    expect(client.uploadBlob).toHaveBeenCalledWith(expect.any(File), { accountId: JMAP_ACCOUNT, noHold: true });
    expect(onDraftSent).toHaveBeenCalledTimes(1);
    expect(await readLocalDrafts('acc')).toEqual([]);
  });

  it('holds a large file in pieces and reads it back whole', async () => {
    const size = 2 * 1024 * 1024 + 3;
    const held = await holdFile('acc', new File([new Uint8Array(size).fill(4)], 'big.bin'), 'big.bin');
    expect(held.size).toBe(size);
    const area = vi.spyOn(store, 'area');
    const file = await heldFile('acc', held.blobId);
    expect(file?.name).toBe('big.bin');
    expect(file?.size).toBe(size);
    expect(new Uint8Array(await (file as File).arrayBuffer()).every((value) => value === 4)).toBe(true);
    area.mockRestore();
  });

  it('tells the user about a refused draft, keeps it, and lists it with its error', async () => {
    const client = fakeClient();
    server.refuseCreate = { type: 'overQuota', description: 'No room' };
    const id = await saveOffline('Too much');
    const notify = vi.fn();
    await flushQueue('acc', client as unknown as JMAPClient, { notify, allowed: () => true });
    expect(notify).toHaveBeenCalledWith({ kind: 'draft-refused', subject: 'Too much', error: { type: 'overQuota', text: 'No room' } });
    await refreshQueueState();
    expect(useOfflineStore.getState().localDrafts).toMatchObject([{ account: 'acc', localId: id, status: 'refused' }]);

    server.refuseCreate = null;
    await retryLocalDraft('acc', id);
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(server.drafts()).toHaveLength(1);
  });

  it('stops on an outage and carries on with what waited after it', async () => {
    const client = fakeClient();
    await saveOffline('One');
    server.offline = true;
    const sendEmail = client.sendEmail;
    const entry = await queueSend('acc', { subject: 'Queued', to: [] }, { kind: 'email', args: [['b@example.org'], 'Queued', 'x'] });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(sendEmail).not.toHaveBeenCalled();
    server.offline = false;
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(server.drafts()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(entry).toBeGreaterThan(0);
  });

  it('sends a draft kept here through the send path with its files, and the draft doesn\'t go up as well', async () => {
    const held = await holdFile('acc', new File(['hello'], 'note.txt', { type: 'text/plain' }), 'note.txt');
    const id = await saveOffline('To send', [{ blobId: held.blobId, type: 'text/plain', name: 'note.txt' }]);
    const client = fakeClient({
      // As the client does: the draft goes once the message is out.
      sendEmail: vi.fn(async () => {
        await store.answer('acc', [['Email/set', { accountId: JMAP_ACCOUNT, destroy: [id] }, 'd']]);
        return { scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' };
      }),
    });
    await queueSend('acc', { subject: 'To send', to: [] }, {
      kind: 'email',
      args: [['b@example.org'], 'To send', 'x', undefined, undefined, 'i', 'alice@example.org', id, undefined, undefined, [{ blobId: held.blobId, name: 'note.txt', type: 'text/plain', size: 5 }]],
    });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
    expect(((client.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[])[10]).toMatchObject([{ blobId: server.uploads[0].blobId }]);
    expect(server.drafts()).toEqual([]);
    expect(await readLocalDrafts('acc')).toEqual([]);
  });

  it('drops the draft of a send the lookup found went out', async () => {
    const id = await saveOffline('Went out');
    const client = fakeClient();
    server.addEmail({ id: 'in-sent', subject: 'Went out', mailboxIds: { sent: true }, messageId: ['fixed@example.org'], receivedAt: new Date().toISOString() });
    const entryId = await queueSend('acc', { subject: 'Went out', to: [] }, {
      kind: 'email',
      args: [['b@example.org'], 'Went out', 'x', undefined, undefined, 'i', 'alice@example.org', id],
    }, undefined, 'fixed@example.org');
    await store.area('acc', 'outbox.claim', { id: entryId });
    await store.area('acc', 'outbox.update', { id: entryId, status: 'uncertain' });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(await readLocalDrafts('acc')).toEqual([]);
    expect(server.drafts()).toEqual([]);
  });

  it('cleans held files nothing needs, only long after', async () => {
    const client = fakeClient();
    const orphan = await holdFile('acc', new File(['a'], 'a.txt'), 'a.txt');
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(await heldFile('acc', orphan.blobId)).not.toBeNull();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    clock.mockRestore();
    expect(await heldFile('acc', orphan.blobId)).toBeNull();
  });
});

describe('a notice before the host is there', () => {
  it('waits for it, and comes once', async () => {
    vi.resetModules();
    const fresh = await import('../offline-mode');
    fresh.offlineNotify({ kind: 'store-reset' });
    const show = vi.fn();
    fresh.setOfflineNotifier(show);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ kind: 'store-reset' });
    fresh.setOfflineNotifier(vi.fn());
    expect(show).toHaveBeenCalledTimes(1);
    vi.resetModules();
  });

  it('goes straight to a host that\'s there', () => {
    const show = vi.fn();
    setOfflineNotifier(show);
    offlineNotify({ kind: 'store-reset' });
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('what a sign-out asks about', () => {
  it('counts a draft only on this device', async () => {
    await saveOffline('Only here');
    expect(await unsentCount('acc')).toMatchObject({ messages: 1 });
  });

  it('counts a draft a waiting send names once, as that send', async () => {
    const id = await saveOffline('Being sent');
    await queueSend('acc', { subject: 'Being sent', to: [] }, { kind: 'email', args: [['b@example.org'], 'Being sent', 'x', undefined, undefined, 'i', 'alice@example.org', id] });
    expect(await unsentCount('acc')).toMatchObject({ messages: 1 });
  });
});

describe('a wipe and local drafts', () => {
  it('names them as lost when the user didn\'t agree', async () => {
    // A second account stays, so the wipe doesn't take the whole store.
    await saveOffline('Only here');
    await refreshQueueState();
    consumeLost();
    await wipeAccount('acc');
    expect(consumeLost()).toEqual(['Only here']);
  });
});

describe('a flush that stops', () => {
  it('tries again soon when a passing failure stopped it', async () => {
    await saveOffline('One');
    server.offline = true;
    const retryLater = vi.fn();
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, retryLater });
    expect(retryLater).toHaveBeenCalled();
  });

  it('doesn\'t when nothing stopped it', async () => {
    await saveOffline('One');
    const retryLater = vi.fn();
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, retryLater });
    expect(retryLater).not.toHaveBeenCalled();
  });
});

describe('a reload in the middle of a flush', () => {
  const nav = navigator as Navigator & { locks?: unknown };
  afterEach(() => {
    Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
  });

  async function leftSending() {
    const id = await saveOffline('Left on the way');
    expect(await store.area('acc', 'drafts.claim', { localId: id })).toBe(true);
    return id;
  }

  it('goes on at once under the flush lock: nobody else can be sending it', async () => {
    Object.defineProperty(nav, 'locks', { configurable: true, value: { request: (_name: string, run: () => Promise<unknown>) => run() } });
    await leftSending();
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(server.drafts()).toHaveLength(1);
  });

  it('waits the minute without Web Locks, because another tab may be on it', async () => {
    await leftSending();
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(server.drafts()).toEqual([]);
  });
});

describe('an old version in another login', () => {
  function clients() {
    const other = { ...fakeClient(), deleteEmail: vi.fn(async () => {}) };
    useAuthStore.setState({ getClientForAccount: ((id: string) => (id === 'other' ? other : undefined)) as never });
    return other;
  }

  it('stays until the new version is on the server, then goes through its own login', async () => {
    const other = clients();
    server.addEmail({ id: 'R', subject: 'Elsewhere', mailboxIds: { drafts: true }, keywords: { $draft: true } });
    const id = await saveOffline('New');
    await noteDraftReplacedElsewhere('acc', id, { login: 'other', jmap: JMAP_ACCOUNT, id: 'R' });
    expect(other.deleteEmail).not.toHaveBeenCalled();
    server.refuseCreate = { type: 'overQuota' };
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(other.deleteEmail).not.toHaveBeenCalled();
    server.refuseCreate = null;
    await retryLocalDraft('acc', id);
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(other.deleteEmail).toHaveBeenCalledWith('R', JMAP_ACCOUNT);
  });

  it('stays when it\'s no longer a draft there', async () => {
    const other = clients();
    server.addEmail({ id: 'R', subject: 'Sent elsewhere', mailboxIds: { drafts: true }, keywords: {} });
    const id = await saveOffline('New');
    await noteDraftReplacedElsewhere('acc', id, { login: 'other', jmap: JMAP_ACCOUNT, id: 'R' });
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(other.deleteEmail).not.toHaveBeenCalled();
  });

  it('carries over to the next save, and waits for that login to be there', async () => {
    useAuthStore.setState({ getClientForAccount: (() => undefined) as never });
    server.addEmail({ id: 'R', subject: 'Elsewhere', mailboxIds: { drafts: true }, keywords: { $draft: true } });
    const first = await saveOffline('First');
    await noteDraftReplacedElsewhere('acc', first, { login: 'other', jmap: JMAP_ACCOUNT, id: 'R' });
    const second = await saveOffline('Second');
    await store.answer('acc', [['Email/set', { accountId: JMAP_ACCOUNT, destroy: [first], replacedBy: second }, 'd']]);
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(server.emails.has('R')).toBe(true);
    const other = clients();
    await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(other.deleteEmail).toHaveBeenCalledWith('R', JMAP_ACCOUNT);
  });
});
