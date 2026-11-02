import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import { setSendGuardSource } from '@/lib/plugin-send-guards';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { beginComposeTakeover, completesComposeTakeover, endComposeTakeover, resetComposeTakeovers } from '@/lib/outgoing/compose-takeover';
import type { JMAPClient } from '@/lib/jmap/client';
import type { InstalledPlugin } from '@/lib/plugin-types';
import {
  confirmLoss,
  enforcePolicy,
  inScope,
  offlineSessionFor,
  pluginsNotRunning,
  recordAnswer,
  scopeOf,
  startOfflineMode,
  stricterNow,
  wipeEverything,
} from '../offline-mode';
import { flushQueue, settleStaleSends, SENDING_STALE_MS } from '../flush';
import { claimForSending, holdFile, queueSend, readQueue } from '../queue';
import { emailIndex, emailKey, forgetIndexes, getBlob, messageOfBlob, putBlob, putEmails, putMisc, removeEmails } from '../cache';
import { forgetDeviceKey } from '../crypto';
import { allowOfflineDbCreation, deleteOfflineDb, idbGetAll, openOfflineDb } from '../db';
import { consumeLost } from '../lost';
import { shellFiles } from '../shell';
import { isOfflineNow, OFFLINE_ACCOUNTS_KEY, setServerDown, useOfflineStore, writeEnabled } from '../state';

const day = 24 * 60 * 60 * 1000;
const recent = () => new Date(Date.now() - day).toISOString();

function fakeClient(server = 'https://mail.example.org', overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => server,
    getUsername: () => 'alice@example.org',
    getAccountId: () => 'j1',
    isOfflineOnly: () => false,
    getSessionSnapshot: () => ({ apiUrl: `${server}/jmap` }),
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' })),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: `server-${file.name}`, size: file.size, type: file.type })),
    applyEmailPatches: vi.fn(async () => []),
    pruneEmailSubmissions: vi.fn(async () => {}),
    ...overrides,
  };
}

function setPolicyOrg(organisation: Record<string, unknown>) {
  usePolicyStore.setState({ loaded: true, source: 'server', subject: null, subjectPending: false, policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, ...organisation } as never } });
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

let stop: () => void = () => {};

beforeEach(async () => {
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  allowOfflineDbCreation();
  localStorage.clear();
  sessionStorage.clear();
  setOnline(true);
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, browserOffline: false, downServers: [], startedOffline: false });
  setPolicyOrg({});
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'acc', client: null });
  setSendGuardSource(null);
  resetComposeTakeovers();
});

afterEach(async () => {
  stop();
  stop = () => {};
  setOnline(true);
  setSendGuardSource(null);
  await wipeEverything();
});

describe('1: two tabs never send the same message', () => {
  it('only one claim wins', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] });
    const results = await Promise.all([claimForSending(id), claimForSending(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readQueue('acc')).outbox[0].status).toBe('sending');
  });

  it('a message another tab took isn’t sent here', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [['b@example.org'], 'S', 'x'] });
    await claimForSending(id);
    const client = fakeClient();
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it('runs under a Web Lock per account where the browser has them', async () => {
    const request = vi.fn(async (_name: string, run: () => Promise<void>) => run());
    Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request } });
    try {
      await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
      expect(request).toHaveBeenCalledWith('bulwark-offline-flush:acc', expect.any(Function));
    } finally {
      delete (window.navigator as { locks?: unknown }).locks;
    }
  });
});

describe('2: a send that may have reached the server is never queued or sent again', () => {
  it('puts a send back to waiting only when it never started', async () => {
    const notStarted = Object.assign(new Error('x'), { name: 'SendNotStartedError' });
    const client = fakeClient(undefined, { sendEmail: vi.fn(async () => { throw notStarted; }) });
    await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [['b@example.org'], 'S', 'x'] });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect((await readQueue('acc')).outbox[0].status).toBe('waiting');
  });

  it('the store keeps a composer send again only when it never started', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    const args = [['b@example.org'], 'S', 'x', undefined, undefined, 'i1', 'alice@example.org', undefined, 'Alice', undefined, undefined, undefined, undefined, undefined, undefined, { outbox: true }] as const;
    // The browser goes offline between the click and the submission.
    const notStarted = vi.fn(async () => { setOnline(false); throw Object.assign(new Error('x'), { name: 'SendNotStartedError' }); });
    const result = await useEmailStore.getState().sendEmail(fakeClient(undefined, { sendEmail: notStarted }) as never, ...(args as unknown as [string[], string, string]));
    expect(result.queued).toBe(true);
    setOnline(true);
    const midway = vi.fn(async () => { setOnline(false); throw new TypeError('Failed to fetch'); });
    await expect(useEmailStore.getState().sendEmail(fakeClient(undefined, { sendEmail: midway }) as never, ...(args as unknown as [string[], string, string]))).rejects.toThrow('Failed to fetch');
    expect((await readQueue('acc')).outbox).toHaveLength(1);
  });
});

describe('3: every sign-out the user didn’t agree to names the lost messages', () => {
  it('names them for the sign-in page, unless the user agreed', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await queueSend('acc', { subject: 'Quarterly', to: [] }, { kind: 'email', args: [] });
    await runBeforeSignOut('all');
    expect(consumeLost()).toEqual(['Quarterly']);

    sessionStorage.clear();
    confirmLoss('all');
    await runBeforeSignOut('all');
    expect(consumeLost()).toEqual([]);
  });

  it('an account removed while another stays signed in: a notice now', async () => {
    useAccountStore.setState({ accounts: [{ id: 'acc' } as never, { id: 'other' } as never] });
    writeEnabled(['acc', 'other']);
    const notices: unknown[] = [];
    const { setOfflineNotifier } = await import('../offline-mode');
    setOfflineNotifier((n) => notices.push(n));
    stop = startOfflineMode();
    await queueSend('acc', { subject: 'Lost one', to: [] }, { kind: 'email', args: [] });
    useAccountStore.setState({ accounts: [{ id: 'other' } as never] });
    await vi.waitFor(() => expect(notices).toContainEqual({ kind: 'lost', subjects: ['Lost one'] }));
    setOfflineNotifier(() => {});
  });
});

describe('4: no queueing while a plugin isn’t running', () => {
  const plugin = (status: InstalledPlugin['status']) => ({ id: 'smime', name: 'S/MIME', status, permissions: [] }) as unknown as InstalledPlugin;
  const source = (plugins: InstalledPlugin[]) => ({ snapshot: () => ({ plugins, forced: () => false }), subscribe: () => () => {} });

  it('refuses while an enabled plugin hasn’t started', async () => {
    setSendGuardSource(source([plugin('enabled')]));
    expect(pluginsNotRunning()).toBe(true);
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await expect(useEmailStore.getState().sendEmail(fakeClient() as never, ['b@example.org'], 'S', 'x', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { outbox: true }))
      .rejects.toMatchObject({ name: 'OfflinePluginsDownError' });
    expect((await readQueue('acc')).outbox).toHaveLength(0);
  });

  it('keeps it when every plugin runs, or is off', () => {
    setSendGuardSource(source([plugin('running'), plugin('disabled')]));
    expect(pluginsNotRunning()).toBe(false);
  });
});

describe('5: another tab switching it off sticks', () => {
  it('follows the switch from another tab and doesn’t create the database again', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: recent() }]);
    // The other tab: switched off, database deleted.
    await deleteOfflineDb();
    window.dispatchEvent(new StorageEvent('storage', { key: OFFLINE_ACCOUNTS_KEY, newValue: null }));
    expect(useOfflineStore.getState().enabled).toEqual([]);
    await expect(openOfflineDb()).rejects.toMatchObject({ name: 'OfflineDbMissingError' });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-offline');
  });
});

describe('6: queued mail and a stricter policy', () => {
  it('holds a message finished without a label once a label is required', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] }, { labelRequired: false, hasLabel: false, guards: [] });
    const entry = (await readQueue('acc')).outbox.find((e) => e.id === id)!;
    expect(stricterNow(entry)).toBe(false);
    setPolicyOrg({ labels: { list: [{ id: 'c', name: 'C', color: '#000000', marking: 'C', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' }], defaultId: '', required: true, extraHeader: '' } });
    expect(stricterNow(entry)).toBe(true);
    const client = fakeClient();
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, stricterNow });
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox[0].status).toBe('held');
  });
});

describe('7: a send of a closed tab isn’t stuck', () => {
  it('becomes uncertain after a minute', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] });
    await claimForSending(id);
    await settleStaleSends('acc');
    expect((await readQueue('acc')).outbox[0].status).toBe('sending');
    await settleStaleSends('acc', Date.now() + SENDING_STALE_MS + 1000);
    expect((await readQueue('acc')).outbox[0].status).toBe('uncertain');
  });
});

describe('8: only parts of kept messages are kept, and go with them', () => {
  it('knows which message a blob belongs to and deletes it with the message', async () => {
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: recent(), bodyValues: {}, attachments: [{ blobId: 'b1', name: 'a.pdf' }] }]);
    expect(await messageOfBlob('acc', 'j1', 'b1')).toMatchObject({ key: emailKey('acc', 'j1', 'm1') });
    expect(await messageOfBlob('acc', 'j1', 'export-of-a-whole-message')).toBeNull();
    await putBlob('acc', 'j1', 'b1', new Blob(['x']), Date.now(), emailKey('acc', 'j1', 'm1'));
    await removeEmails('acc', [emailKey('acc', 'j1', 'm1')]);
    expect(await getBlob('acc', 'j1', 'b1')).toBeNull();
  });
});

describe('9: folders that went away', () => {
  it('drops opened folders the folder list no longer has', async () => {
    await putMisc('acc', 'mailboxes', { j1: [{ id: 'inbox', role: 'inbox' }, { id: 'kept' }] });
    await putMisc('acc', 'opened', { j1: ['kept', 'deleted'] });
    expect((await scopeOf('acc')).opened).toEqual({ j1: ['kept'] });
  });
});

describe('10: no decision on an account whose groups aren’t known yet', () => {
  it('doesn’t wipe the active account while its subject is pending', async () => {
    writeEnabled(['acc']);
    setPolicyOrg({ devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } });
    usePolicyStore.setState({ subjectPending: true });
    enforcePolicy();
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
    usePolicyStore.setState({ subjectPending: false });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
  });
});

describe('11: starting from the device', () => {
  it('uses the policy kept from the last fetch, never the defaults', async () => {
    writeEnabled(['acc']);
    await putMisc('acc', 'session', { apiUrl: 'x' });
    localStorage.setItem('bulwark-policy-last', JSON.stringify({ ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } } }));
    usePolicyStore.setState({ loaded: false, fetching: false, source: 'none' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    try {
      expect(await offlineSessionFor('acc')).toBeNull();
      expect(usePolicyStore.getState().source).toBe('cache');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('12: one server down doesn’t hold another’s mail', () => {
  it('counts servers apart', () => {
    setServerDown('https://a.example.org', true);
    expect(isOfflineNow('https://a.example.org/')).toBe(true);
    expect(isOfflineNow('https://b.example.org')).toBe(false);
  });
});

describe('13: file names stay sealed', () => {
  it('keeps no name or type of a held file readable', async () => {
    await holdFile('acc', new File(['x'], 'merger-plan.pdf', { type: 'application/pdf' }), 'merger-plan.pdf');
    const records = await idbGetAll<Record<string, unknown>>('uploads');
    expect(JSON.stringify(records.map((r) => ({ ...r, data: undefined, iv: undefined, meta: undefined })))).not.toMatch(/merger|pdf/);
  });
});

describe('14: the shell of another build isn’t kept under this one', () => {
  it('lists nothing when the server runs another build', async () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'build-a');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ buildId: 'build-b', files: ['/_next/static/x.js'] }))));
    try {
      expect(await shellFiles()).toEqual([]);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ buildId: 'build-a', files: ['/_next/static/x.js'] }))));
      expect(await shellFiles()).toEqual(['/_next/static/x.js']);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('15: only the plugin running the composer’s send counts', () => {
  it('matches the plugin and the identity of an open takeover', async () => {
    const seen: boolean[] = [];
    const token = beginComposeTakeover('i1');
    emailHooks.onComposeSend.register('smime', () => {
      seen.push(completesComposeTakeover('smime', 'i1'), completesComposeTakeover('other', 'i1'), completesComposeTakeover('smime', 'i2'));
      return false;
    });
    await emailHooks.onComposeSend.takeOver({} as never);
    endComposeTakeover(token);
    clearAllHooks();
    expect(seen).toEqual([true, false, false]);
    expect(completesComposeTakeover('smime', 'i1')).toBe(false);
  });
});

describe('recording: what the cache takes', () => {
  it('keeps recent mail of the Inbox and opened folders, refreshes kept messages, skips the rest', async () => {
    const scope = { inbox: { j1: 'inbox' }, opened: { j1: ['projects'] } };
    expect(inScope(scope, 'j1', { id: 'a', mailboxIds: { inbox: true }, receivedAt: recent() })).toBe(true);
    expect(inScope(scope, 'j1', { id: 'b', mailboxIds: { projects: true }, receivedAt: recent() })).toBe(true);
    expect(inScope(scope, 'j1', { id: 'c', mailboxIds: { archive: true }, receivedAt: recent() })).toBe(false);
    expect(inScope(scope, 'j1', { id: 'd', mailboxIds: { inbox: true }, receivedAt: new Date(Date.now() - 40 * day).toISOString() })).toBe(false);

    await putMisc('acc', 'mailboxes', { j1: [{ id: 'inbox', role: 'inbox', name: 'Inbox' }] });
    await recordAnswer('acc', 'j1', [['Email/get', { ids: ['a', 'c'] }, '0'], ['Mailbox/get', { properties: ['id', 'role'] }, '1']], {
      methodResponses: [
        ['Email/get', { accountId: 'j1', list: [{ id: 'a', mailboxIds: { inbox: true }, receivedAt: recent() }, { id: 'c', mailboxIds: { archive: true }, receivedAt: recent() }] }, '0'],
        ['Mailbox/get', { accountId: 'j1', list: [{ id: 'inbox', role: 'inbox' }] }, '1'],
      ],
    });
    const index = await emailIndex('acc');
    expect([...index.values()].map((e) => e.id)).toEqual(['a']);
    // A partial folder list (id and role only) doesn't replace the full one.
    expect((await scopeOf('acc')).inbox).toEqual({ j1: 'inbox' });
  });
});
