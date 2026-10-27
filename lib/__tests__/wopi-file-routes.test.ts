// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// WOPI for Files nodes (#425): PutFile stamps `modified` through the server,
// refuses stale saves, and works for a node in someone else's shared drive.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 'x'.repeat(32),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (_key: string, fallback: unknown) => fallback, ensureLoaded: async () => {} },
}));
vi.mock('@/lib/wopi/discovery', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/wopi/discovery')>()),
  getWopiActions: vi.fn(),
}));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: vi.fn(),
  isTrustedJmapServerUrl: async () => true,
}));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(),
  postJmap: vi.fn(),
  rebaseApiUrl: () => null,
}));

import { POST as launch } from '@/app/api/wopi/launch/route';
import { GET as checkFileInfo } from '@/app/api/wopi/files/[fileId]/route';
import { POST as putFile } from '@/app/api/wopi/files/[fileId]/contents/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getWopiActions } from '@/lib/wopi/discovery';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';
import { shareeSavesNeedRename, updateFileNodeBlob } from '@/lib/wopi/files';
import { mintWopiToken, wopiDocumentId } from '@/lib/wopi/token';
import { endlessResponse } from './helpers/endless-body';

process.env.ADMIN_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'bw-wopi-files-'));

const ORIGIN = 'https://webmail.example.com';
const SERVER = 'https://mail.example.com';
const OFFICE = 'https://office.example.com/browser/abc/cool.html?';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LOADED = '2026-09-25T10:00:00Z';
const SAVED = '2026-09-25T10:05:00Z';
// The logged-in user's own account, and another user's account that shares
// a folder with them.
const OWN = 'u1';
const OWNER = 'owner1';

const ALL_RIGHTS = {
  mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: true,
};

interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  type: string;
  blobId: string;
  size: number;
  modified: string;
  myRights: Record<string, boolean>;
}

type MethodCall = [string, Record<string, unknown>, string];

let version: '0.16' | '1.0';
let drives: Record<string, Record<string, FakeNode>>;
// Accounts the user is a member of: their own, and a group drive if a test adds one.
let memberOf: Set<string>;
let sent: MethodCall[];

const filenodeAccount = (depth: number | null = version === '1.0' ? 64 : null) => ({
  accountCapabilities: { 'urn:ietf:params:jmap:filenode': { maxFileNodeDepth: depth, maxSizeFileNodeName: 255 } },
});

const node = (id: string, rights = ALL_RIGHTS): FakeNode => ({
  id, parentId: null, name: 'Report.docx', type: DOCX, blobId: `G-old-${id}`, size: 10, modified: LOADED, myRights: rights,
});

/**
 * FileNode/get and FileNode/set the way Stalwart answers them. A blob can
 * only be used by members of the account it was uploaded into (Stalwart's
 * `has_access_blob`, the same on 0.16 and 1.0). A sharee needs
 * mayModifyContent for a content update on 1.0, and mayRename (the Modify
 * right) for any update on 0.16. 1.0 stamps `modified` on a content update
 * only when the patch asks for it and echoes it in `updated`; 0.16.6+ always
 * bump it and answer `updated: {id: null}`.
 */
function fakeJmapServer() {
  (postJmap as Mock).mockImplementation(async (_url: string, _auth: string, body: string) => {
    const { methodCalls } = JSON.parse(body) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([method, args, callId]) => {
      sent.push([method, args, callId]);
      const drive = drives[args.accountId as string] ?? {};
      if (method === 'FileNode/get') {
        const ids = args.ids as string[];
        return [method, {
          list: ids.filter((id) => drive[id]).map((id) => ({ ...drive[id] })),
          notFound: ids.filter((id) => !drive[id]),
        }, callId];
      }
      if (method === 'FileNode/set') {
        const updated: Record<string, unknown> = {};
        const notUpdated: Record<string, unknown> = {};
        const sharee = !memberOf.has(args.accountId as string);
        for (const [id, patch] of Object.entries(args.update as Record<string, { blobId: string; modified?: null }>)) {
          if (!memberOf.has(patch.blobId.split('-')[1])) {
            notUpdated[id] = { type: 'forbidden', description: `You do not have access to blobId ${patch.blobId}.` };
            continue;
          }
          const target = drive[id];
          if (sharee && version === '0.16' && !target.myRights.mayRename) {
            notUpdated[id] = { type: 'forbidden', description: 'You are not allowed to modify this file node.' };
            continue;
          }
          if (sharee && version === '1.0' && !target.myRights.mayModifyContent) {
            notUpdated[id] = { type: 'forbidden', description: 'You are not allowed to modify the content of this file node.' };
            continue;
          }
          target.blobId = patch.blobId;
          target.size = 5;
          if (version === '1.0') {
            if (patch.modified === null) target.modified = SAVED;
            updated[id] = { changed: SAVED, size: 5, ...(patch.modified === null ? { modified: SAVED } : {}) };
          } else {
            target.modified = SAVED;
            updated[id] = null;
          }
        }
        return [method, { updated, notUpdated }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    return new Response(JSON.stringify({ methodResponses }), { status: 200 });
  });
}

function request(url: string, init: { body?: unknown; bytes?: ArrayBuffer; headers?: Record<string, string> } = {}) {
  const parsed = new URL(url, ORIGIN);
  return {
    nextUrl: parsed,
    headers: new Headers(init.headers),
    json: async () => init.body,
    arrayBuffer: async () => init.bytes ?? new ArrayBuffer(0),
  } as unknown as Parameters<typeof launch>[0];
}

const params = (id: string) => ({ params: Promise.resolve({ fileId: id }) });

async function launchFile(body: Record<string, unknown>) {
  const res = await launch(request('/api/wopi/launch', { body }));
  return { status: res.status, data: await res.json() };
}

/** The document id and token the editor would call back with. */
function editorCall(data: { url: string; accessToken: string }) {
  const wopiSrc = new URL(new URL(data.url).searchParams.get('WOPISrc')!);
  const documentId = decodeURIComponent(wopiSrc.pathname.split('/').pop()!);
  return { documentId, token: `access_token=${encodeURIComponent(data.accessToken)}` };
}

async function save(call: { documentId: string; token: string }, timestamp = LOADED) {
  const res = await putFile(
    request(`/api/wopi/files/${call.documentId}/contents?${call.token}`, {
      bytes: new TextEncoder().encode('SAVED').buffer as ArrayBuffer,
      headers: { 'X-WOPI-Override': 'PUT', 'X-COOL-WOPI-Timestamp': timestamp },
    }),
    params(call.documentId),
  );
  return { status: res.status, data: await res.json() };
}

const uploads = () => (fetchJmapServer as Mock).mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  .map(([url]) => url as string);
const setCalls = () => sent.filter(([method]) => method === 'FileNode/set').map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  version = '1.0';
  drives = { [OWN]: { f1: node('f1') }, [OWNER]: {} };
  memberOf = new Set([OWN]);
  sent = [];
  (getStalwartCredentials as Mock).mockResolvedValue({
    serverUrl: SERVER,
    authHeader: 'Basic dXNlcjpwYXNz',
    username: 'user@example.com',
    trusted: true,
    slot: 0,
    hasSessionCookie: true,
  });
  (getWopiActions as Mock).mockResolvedValue({ edit: { docx: OFFICE }, view: {} });
  (fetchJmapSession as Mock).mockImplementation(async () => ({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': OWN, 'urn:ietf:params:jmap:filenode': OWN },
    // 1.0 advertises maxFileNodeDepth 64, 0.16 null, on the shared account too.
    accounts: { [OWN]: filenodeAccount(), [OWNER]: filenodeAccount() },
    downloadUrl: 'https://public.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    uploadUrl: 'https://public.example.com/jmap/upload/{accountId}/',
  }));
  (fetchJmapServer as Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const account = decodeURIComponent(new URL(url).pathname.split('/')[3]);
      return new Response(JSON.stringify({ accountId: account, blobId: `G-${account}-1`, type: DOCX, size: 5 }), { status: 200 });
    }
    return new Response('DOCX-BYTES', { status: 200, headers: { 'Content-Length': '10' } });
  });
  fakeJmapServer();
});

describe('WOPI PutFile for a Files node', () => {
  it('asks the server to stamp `modified` and reports the time it echoes on Stalwart 1.0', async () => {
    const { data } = await launchFile({ fileId: 'f1' });
    const res = await save(editorCall(data));

    expect(res).toEqual({ status: 200, data: { LastModifiedTime: SAVED } });
    expect(setCalls()).toEqual([{ accountId: OWN, update: { f1: { blobId: `G-${OWN}-1`, modified: null } } }]);
    expect(drives[OWN].f1.modified).toBe(SAVED);
  });

  it('uploads the save with the media type Stalwart 1.0.0 lists as mediaType', async () => {
    // 1.0.0 (File Storage draft 18) has no `type`; 0.16 has no `mediaType`.
    const { type, ...rest } = drives[OWN].f1;
    drives[OWN].f1 = { ...rest, '@type': 'File', mediaType: type } as unknown as FakeNode;
    const { data } = await launchFile({ fileId: 'f1' });
    await save(editorCall(data));

    const upload = (fetchJmapServer as Mock).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect((upload?.[1] as RequestInit).headers).toMatchObject({ 'Content-Type': DOCX });
    const get = sent.find(([method]) => method === 'FileNode/get');
    expect(get?.[1].properties).toEqual(expect.arrayContaining(['type', 'mediaType']));
  });

  it('reads the new `modified` back when the server answers `updated: null` on 0.16', async () => {
    version = '0.16';
    const { data } = await launchFile({ fileId: 'f1' });
    const res = await save(editorCall(data));

    expect(res).toEqual({ status: 200, data: { LastModifiedTime: SAVED } });
    // The get travels in the same request as the set.
    const request = sent.map(([method]) => method);
    expect(request.slice(-2)).toEqual(['FileNode/set', 'FileNode/get']);
  });

  it('takes the stamp from `updated` without the get on Stalwart 1.0', async () => {
    (postJmap as Mock).mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [
        ['FileNode/set', { updated: { f1: { changed: SAVED, size: 5, modified: SAVED } } }, 's0'],
        ['FileNode/get', { list: [], notFound: ['f1'] }, 'g1'],
      ],
    }), { status: 200 }));
    const ctx = { serverUrl: SERVER, authHeader: 'Basic x', trusted: true };
    await expect(updateFileNodeBlob(ctx, OWN, 'f1', 'G-u1-1')).resolves.toEqual({ modified: SAVED });
  });

  it('answers 409 with COOLStatusCode 1010 when the document changed since the editor loaded it', async () => {
    const { data } = await launchFile({ fileId: 'f1' });
    const call = editorCall(data);
    // Someone else saved in the meantime.
    drives[OWN].f1.modified = '2026-09-25T10:02:00Z';

    const res = await save(call, LOADED);
    expect(res).toEqual({ status: 409, data: { COOLStatusCode: 1010 } });
    expect(uploads()).toEqual([]);
    expect(setCalls()).toEqual([]);
  });

  it('refuses a document over the size limit instead of saving part of it', async () => {
    const { data } = await launchFile({ fileId: 'f1' });
    const call = editorCall(data);
    const big = endlessResponse(200);
    const req = {
      ...request(`/api/wopi/files/${call.documentId}/contents?${call.token}`, { headers: { 'X-WOPI-Override': 'PUT' } }),
      body: big.response.body,
    } as unknown as Parameters<typeof putFile>[0];

    const res = await putFile(req, params(call.documentId));
    expect(res.status).toBe(413);
    expect(big.pulled()).toBeLessThan(110);
    expect(uploads()).toEqual([]);
    expect(setCalls()).toEqual([]);
  });

  it('turns a refused update into a server error', async () => {
    const { data } = await launchFile({ fileId: 'f1' });
    (postJmap as Mock).mockImplementation(async (_url: string, _auth: string, body: string) => {
      const { methodCalls } = JSON.parse(body) as { methodCalls: MethodCall[] };
      const methodResponses = methodCalls.map(([method, , callId]) => method === 'FileNode/get'
        ? [method, { list: [{ ...drives[OWN].f1 }] }, callId]
        : [method, { notUpdated: { f1: { type: 'forbidden', description: 'You are not allowed to modify the content of this file node.' } } }, callId]);
      return new Response(JSON.stringify({ methodResponses }), { status: 200 });
    });
    expect((await save(editorCall(data))).status).toBe(500);
  });
});

describe('WOPI for a node in a shared drive', () => {
  beforeEach(() => {
    drives[OWNER] = { n5: node('n5') };
  });

  it('opens the node in its owner\'s account and saves with a blob from the user\'s own account', async () => {
    // The Files app sends the owner's account and the node's own id, not the
    // "owner1:n5" id it lists shared nodes under.
    const { status, data } = await launchFile({ fileId: 'n5', accountId: OWNER });
    expect(status).toBe(200);
    expect(data.readOnly).toBe(false);
    expect(sent[0]).toEqual(['FileNode/get', expect.objectContaining({ accountId: OWNER, ids: ['n5'] }), 'g0']);

    // Same WOPISrc as when the owner opens it: both edit one session.
    const call = editorCall(data);
    expect(call.documentId).toBe(wopiDocumentId({ kind: 'file', serverUrl: SERVER, accountId: OWNER, fileId: 'n5' }));

    const info = await checkFileInfo(request(`/api/wopi/files/${call.documentId}?${call.token}`), params(call.documentId));
    expect(await info.json()).toMatchObject({ BaseFileName: 'Report.docx', UserCanWrite: true, LastModifiedTime: LOADED });

    const res = await save(call);
    expect(res).toEqual({ status: 200, data: { LastModifiedTime: SAVED } });
    expect(uploads()).toEqual([`${SERVER}/jmap/upload/${OWN}/`]);
    expect(setCalls()).toEqual([{ accountId: OWNER, update: { n5: { blobId: `G-${OWN}-1`, modified: null } } }]);
  });

  it('opens read-only for a sharee without mayModifyContent', async () => {
    drives[OWNER].n5.myRights = { ...ALL_RIGHTS, mayModifyContent: false, mayAddChildren: false, mayRename: false, mayDelete: false, mayShare: false };
    const { data } = await launchFile({ fileId: 'n5', accountId: OWNER });
    expect(data.readOnly).toBe(true);

    const res = await save(editorCall(data));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });

  // A share with the content right but not the rename right.
  const CONTENT_ONLY = { ...ALL_RIGHTS, mayRename: false, mayAddChildren: false, mayDelete: false, mayShare: false };

  it('opens read-only on 0.16 for a sharee who may change the content but not rename, since 0.16 refuses that save', async () => {
    version = '0.16';
    drives[OWNER].n5.myRights = CONTENT_ONLY;
    const { data } = await launchFile({ fileId: 'n5', accountId: OWNER });
    expect(data.readOnly).toBe(true);

    // What an editable token would have run into on every save.
    const editable = mintEditableToken(OWNER, 'n5', OWN);
    expect((await save(editable)).status).toBe(500);
    expect(setCalls()).toEqual([{ accountId: OWNER, update: { n5: { blobId: `G-${OWN}-1`, modified: null } } }]);
  });

  it('opens editable on Stalwart 1.0 for a sharee with the content right alone', async () => {
    drives[OWNER].n5.myRights = CONTENT_ONLY;
    const { data } = await launchFile({ fileId: 'n5', accountId: OWNER });
    expect(data.readOnly).toBe(false);
    expect(await save(editorCall(data))).toEqual({ status: 200, data: { LastModifiedTime: SAVED } });
  });

  it('opens editable on 0.16 once the sharee may rename too', async () => {
    version = '0.16';
    drives[OWNER].n5.myRights = { ...CONTENT_ONLY, mayRename: true };
    const { data } = await launchFile({ fileId: 'n5', accountId: OWNER });
    expect(data.readOnly).toBe(false);
    expect(await save(editorCall(data))).toEqual({ status: 200, data: { LastModifiedTime: SAVED } });
  });

  it('keeps uploading into the document\'s account for tokens minted before the upload account existed', async () => {
    // A group drive the user belongs to, so a blob uploaded there is theirs to use.
    memberOf.add(OWNER);
    const res = await save(mintEditableToken(OWNER, 'n5'));
    expect(res.status).toBe(200);
    expect(uploads()).toEqual([`${SERVER}/jmap/upload/${OWNER}/`]);
    expect(setCalls()).toEqual([{ accountId: OWNER, update: { n5: { blobId: `G-${OWNER}-1`, modified: null } } }]);
  });
});

describe('shareeSavesNeedRename', () => {
  it('asks a sharee for mayRename on 0.16 only, told apart by maxFileNodeDepth', () => {
    const session = (shared: object) => ({ accounts: { [OWN]: filenodeAccount(64), [OWNER]: shared } });
    expect(shareeSavesNeedRename({ accounts: { [OWN]: filenodeAccount(null), [OWNER]: filenodeAccount(null) } }, OWNER, OWN)).toBe(true);
    expect(shareeSavesNeedRename(session(filenodeAccount(64)), OWNER, OWN)).toBe(false);
    // A shared account that lists no filenode capability goes by the user's own.
    expect(shareeSavesNeedRename(session({}), OWNER, OWN)).toBe(false);
    // Without a session, the stricter rule: better read-only than an editor that can't save.
    expect(shareeSavesNeedRename(null, OWNER, OWN)).toBe(true);
  });
});

/** An editable token; without `uploadAccountId` as launches minted before it existed. */
function mintEditableToken(accountId: string, fileId: string, uploadAccountId?: string) {
  const payload = {
    serverUrl: SERVER, authHeader: 'Basic dXNlcjpwYXNz', username: 'user@example.com',
    accountId, fileId, kind: 'file' as const, canWrite: true, origin: ORIGIN,
    ...(uploadAccountId ? { uploadAccountId } : {}),
  };
  const documentId = wopiDocumentId(payload);
  const { token } = mintWopiToken(payload);
  return { documentId, token: `access_token=${encodeURIComponent(token)}` };
}
