import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { setStoreBackend } from '@/lib/store/client/api';
import { FakeJmapMail } from '@/lib/store/__tests__/helpers/fake-jmap-mail';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { startOfflineMode, wipeEverything } from '../offline-mode';
import { forgetLegacyMove } from '../migrate-legacy';
import { useOfflineStore, writeEnabled } from '../state';

const SERVER = 'https://mail.example.org';
const SESSION = {
  apiUrl: `${SERVER}/jmap/`,
  downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
  accounts: { acc1: { name: 'alice', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {} } } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' },
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500, maxObjectsInSet: 500 }, 'urn:ietf:params:jmap:mail': {} },
  username: 'alice@example.org',
};

let probeOk = true;
let apiFails: 'no' | 'network' | 'gateway' = 'no';
let server: FakeJmapMail;
let store: InProcessStore;

beforeEach(async () => {
  probeOk = true;
  apiFails = 'no';
  server = new FakeJmapMail({ mailboxes: [
    { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, unreadEmails: 2 },
    { id: 'trash', name: 'Trash', role: 'trash', totalEmails: 0, unreadEmails: 0 },
  ] });
  server.identities.set('i1', { id: 'i1', email: 'alice@example.org', name: 'Alice' });
  server.addEmail({ id: 'm1', subject: 'Kept one', threadId: 't1', keywords: {} });
  server.addEmail({ id: 'm2', subject: 'Kept two', threadId: 't2', keywords: {} });
  store = new InProcessStore(server, SESSION);
  setStoreBackend(store);
  forgetLegacyMove();
  localStorage.clear();
  useOfflineStore.setState({ enabled: [], downServers: [], browserOffline: false, outbox: [], pendingChanges: 0, conflicts: [] });
  usePolicyStore.setState({ loaded: true, subject: null, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', serverUrl: SERVER, username: 'alice@example.org' } as never] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.mode === 'no-cors') {
      if (!probeOk) throw new TypeError('Failed to fetch');
      return new Response(null, { status: 200 });
    }
    if (String(url).endsWith('/.well-known/jmap')) return new Response(JSON.stringify(SESSION), { status: 200 });
    if (apiFails === 'network') throw new TypeError('Failed to fetch');
    if (apiFails === 'gateway') return new Response('<html>Bad Gateway</html>', { status: 502 });
    const body = JSON.parse(String(init?.body)) as { methodCalls: never[] };
    return new Response(JSON.stringify(await server.request(body.methodCalls)), { status: 200 });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await wipeEverything();
  setStoreBackend(null);
});

async function ready() {
  const client = new JMAPClient(SERVER, 'alice@example.org', 'pw');
  await client.connect();
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
  writeEnabled(['acc']);
  const stop = startOfflineMode();
  await store.sync('acc');
  return { client, stop };
}

async function offline(run: () => Promise<void>): Promise<void> {
  vi.stubGlobal('navigator', { onLine: false });
  try {
    await run();
  } finally {
    vi.stubGlobal('navigator', window.navigator);
  }
}

describe('falling back to the device', () => {
  it('answers from the store when the server is gone', async () => {
    const { client, stop } = await ready();
    apiFails = 'network';
    probeOk = false;
    const email = await client.getEmail('m1');
    expect(email?.subject).toBe('Kept one');
    expect(useOfflineStore.getState().downServers).toEqual(['https://mail.example.org']);
    stop();
  });

  it('keeps a refused request an error while the server answers', async () => {
    const { client, stop } = await ready();
    apiFails = 'network';
    probeOk = true;
    // getEmail swallows errors into null: the device's copy isn't passed off as the server's answer.
    expect(await client.getEmail('m1')).toBeNull();
    expect(useOfflineStore.getState().downServers).toEqual([]);
    stop();
  });

  it('counts a proxy\'s 5xx as the server being gone, though a probe would pass', async () => {
    const { client, stop } = await ready();
    apiFails = 'gateway';
    probeOk = true;
    const email = await client.getEmail('m1');
    expect(email?.subject).toBe('Kept one');
    expect(useOfflineStore.getState().downServers).toEqual(['https://mail.example.org']);
    // A later good answer ends it.
    apiFails = 'no';
    await client.getEmail('m1');
    expect(useOfflineStore.getState().downServers).toEqual([]);
    stop();
  });
});

describe('per-call errors, end to end through the client', () => {
  it('keeps the results when one call in the request can\'t be answered', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      // A search with text: Email/query, Email/get, and SearchSnippet/get, which the store refuses.
      const result = await client.searchEmails('kept');
      expect(result.emails.map((email) => email.id).sort()).toEqual(['m1', 'm2']);
      expect(result.emails[0].subject).toBeTruthy();
    });
    stop();
  });

  it('does a full fetch when /changes is refused: the client reads null', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      expect(await client.getEmailChanges('s1')).toBeNull();
      expect(await client.getMailboxChanges('s1')).toBeNull();
    });
    stop();
  });

  it('a draft can\'t be saved yet, and says so the way the composer expects', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      await expect(client.createDraft(['b@example.org'], 'S', 'x', undefined, undefined, undefined, 'alice@example.org')).rejects.toThrow();
    });
    stop();
  });

  it('queues a delete for good and an emptied folder, and the client sees them done', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      await client.deleteEmail('m1');
      expect(await client.getEmail('m1')).toBeNull();
      await client.moveToTrash('m2', 'trash');
      expect(await client.emptyMailbox('trash')).toBe(1);
      const boxes = await client.getMailboxes();
      expect(boxes.find((box) => box.id === 'inbox')).toMatchObject({ totalEmails: 0, unreadEmails: 0 });
      expect(boxes.find((box) => box.id === 'trash')).toMatchObject({ totalEmails: 0 });
    });
    stop();
    // Nothing reached the server yet.
    expect(server.emails.size).toBe(2);
  });

  it('marks read offline and the change reaches the message and the counts', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      await client.markAsRead('m1', true);
      expect((await client.getEmail('m1'))?.keywords).toMatchObject({ $seen: true });
      const boxes = await client.getMailboxes();
      expect(boxes.find((box) => box.id === 'inbox')?.unreadEmails).toBe(1);
    });
    stop();
  });
});

describe('what the store answers and is told', () => {
  it('answers identities', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      expect((await client.getIdentities()).map((identity) => identity.id)).toEqual(['i1']);
    });
    stop();
  });

  it('answers the folder list with the server\'s real state', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      const result = await client.getAllMailboxesWithState();
      expect(result.mailboxes.map((box) => box.id).sort()).toEqual(['inbox', 'trash']);
      expect(Object.values(result.states)).toEqual([server.coll.Mailbox.state()]);
    });
    stop();
  });

  it('never takes a refusal from the device for the answer to a send', async () => {
    const { client, stop } = await ready();
    await client.getMailboxes();
    await client.getIdentities();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const passThrough = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('EmailSubmission/set')) {
        apiFails = 'network';
        probeOk = false;
      }
      return passThrough(url, init);
    });
    server.mailboxes.set('drafts', { id: 'drafts', role: 'drafts' });
    server.mailboxes.set('sent', { id: 'sent', role: 'sent' });
    const error = await client.sendEmail(['bob@example.org'], 'Hi', 'Body', undefined, undefined, 'i1', 'alice@example.org').catch((e: unknown) => e) as Error;
    // The connection broke: "may have gone", not a refusal, and not "never started".
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('Failed to fetch');
    stop();
  });

  it('never lets the device answer for the server when the outbox asks', async () => {
    const { client, stop } = await ready();
    apiFails = 'network';
    probeOk = false;
    await expect(client.requestNetworkOnly([['Email/set', { accountId: 'acc1', update: { m1: { 'keywords/$seen': true } } }, '0']])).rejects.toThrow('Failed to fetch');
    expect(await store.area('acc', 'outbox.read')).toMatchObject({ patches: 0 });
    stop();
  });

  it('keeps a message opened from outside the window', async () => {
    server.addEmail({ id: 'old', subject: 'Old', receivedAt: '2019-01-01T00:00:00Z', bodyValues: { 1: { value: 'Old text' } } });
    const { client, stop } = await ready();
    store.dbs.get('acc')!.run("DELETE FROM email WHERE id = 'old'");
    await client.getEmail('old');
    await vi.waitFor(async () => {
      const answer = await store.answer('acc', [['Email/get', { ids: ['old'], properties: ['subject', 'bodyValues'], fetchAllBodyValues: true }, '0']]);
      expect(answer?.methodResponses[0][1].list[0]?.subject).toBe('Old');
    });
    stop();
  });

  it('tells the store what the server pushed', async () => {
    const { client, stop } = await ready();
    const note = vi.spyOn(store, 'noteStateChange');
    const { getOfflineHooks } = await import('@/lib/jmap/offline-hooks');
    getOfflineHooks()?.stateChange(client, { changed: { acc1: { Email: 's99' } } });
    expect(note).toHaveBeenCalledWith('acc', { acc1: { Email: 's99' } });
    stop();
  });

  it('holds a file while offline and hands it back for the message', async () => {
    const { client, stop } = await ready();
    await offline(async () => {
      const held = await client.uploadBlob(new File(['hello'], 'note.txt', { type: 'text/plain' }));
      expect(held.blobId).toMatch(/^bulwark-local-/);
      const blob = await client.fetchBlob(held.blobId);
      expect(await blob.text()).toBe('hello');
    });
    stop();
  });

  it('answers a search for the merge with the server', async () => {
    const { client, stop } = await ready();
    const { getOfflineHooks } = await import('@/lib/jmap/offline-hooks');
    const answer = await getOfflineHooks()?.searchLocal?.(client, [['Email/query', { filter: { text: 'kept' } }, '0']]);
    expect(answer?.methodResponses[0][1].ids).toHaveLength(2);
    useAccountStore.setState({ accounts: [] });
    useAuthStore.setState({ client: null, activeAccountId: null });
    expect(await getOfflineHooks()?.searchLocal?.(client, [['Email/query', {}, '0']])).toBeNull();
    stop();
  });
});
