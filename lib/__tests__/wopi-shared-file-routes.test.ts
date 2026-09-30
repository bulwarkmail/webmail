// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// #1094: a Files node shared with the user lives in the owner's account.
// The editor must address it there, and PutFile must upload the new content
// into the user's own account - Stalwart refuses a blob the user uploaded
// into the owner's account ("You do not have access to blobId").

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
import { GET as getFile, POST as putFile } from '@/app/api/wopi/files/[fileId]/contents/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getWopiActions } from '@/lib/wopi/discovery';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';

process.env.ADMIN_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'bw-wopi-shared-'));

const ORIGIN = 'https://webmail.example.com';
const OFFICE = 'https://office.example.com/browser/abc/cool.html?';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OWN = 'c';
const OWNER = 'd';

function request(url: string, init: { body?: unknown; bytes?: ArrayBuffer } = {}) {
  return {
    nextUrl: new URL(url, ORIGIN),
    headers: new Headers(),
    json: async () => init.body,
    arrayBuffer: async () => init.bytes ?? new ArrayBuffer(0),
  } as unknown as Parameters<typeof launch>[0];
}

const params = (id: string) => ({ params: Promise.resolve({ fileId: id }) });

function editorCall(data: { url: string; accessToken: string }) {
  const wopiSrc = new URL(new URL(data.url).searchParams.get('WOPISrc')!);
  const documentId = decodeURIComponent(wopiSrc.pathname.split('/').pop()!);
  return { documentId, token: `access_token=${encodeURIComponent(data.accessToken)}` };
}

// The shared node as Stalwart 0.16.23 reports it to the user it is shared with.
let node: { id: string; name: string; type: string; blobId: string; size: number; modified: string; myRights: Record<string, boolean> };
let setCalls: Array<{ accountId: string; update: Record<string, { blobId: string }> }>;

beforeEach(() => {
  vi.clearAllMocks();
  node = {
    id: 'b', name: 'new-file.docx', type: DOCX, blobId: 'Gshared', size: 10, modified: '2026-09-26T20:00:00Z',
    myRights: { mayRead: true, mayRename: true, mayModifyContent: true },
  };
  setCalls = [];
  (getStalwartCredentials as Mock).mockResolvedValue({
    serverUrl: 'https://mail.example.com',
    authHeader: 'Basic dXNlcjpwYXNz',
    username: 'user@example.com',
    trusted: true,
    slot: 0,
    hasSessionCookie: true,
  });
  (getWopiActions as Mock).mockResolvedValue({ edit: { docx: OFFICE }, view: {} });
  (fetchJmapSession as Mock).mockResolvedValue({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': OWN, 'urn:ietf:params:jmap:filenode': OWN },
    accounts: { [OWN]: { isPersonal: true }, [OWNER]: { isPersonal: false } },
  });
  (postJmap as Mock).mockImplementation(async (_url: string, _auth: string, body: string) => {
    const { methodCalls } = JSON.parse(body) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = methodCalls.map(([method, args, callId]) => {
      const inOwner = args.accountId === OWNER;
      if (method === 'FileNode/get') {
        const ids = args.ids as string[];
        const found = inOwner && ids.includes(node.id);
        return [method, { accountId: args.accountId, list: found ? [node] : [], notFound: found ? [] : ids }, callId];
      }
      // FileNode/set
      const update = args.update as Record<string, { blobId: string }>;
      setCalls.push({ accountId: args.accountId as string, update });
      const patch = update[node.id];
      if (!inOwner || !patch) return [method, { notUpdated: { [Object.keys(update)[0]]: { type: 'notFound' } } }, callId];
      if (!patch.blobId.startsWith(`upload-${OWN}-`)) {
        return [method, { notUpdated: { [node.id]: { type: 'forbidden', description: `You do not have access to blobId ${patch.blobId}.` } } }, callId];
      }
      node = { ...node, blobId: patch.blobId, modified: '2026-09-26T21:00:00Z' };
      return [method, { updated: { [node.id]: null } }, callId];
    });
    return new Response(JSON.stringify({ methodResponses }), { status: 200 });
  });
  let uploads = 0;
  (fetchJmapServer as Mock).mockImplementation(async (url: string, init: { method: string }) => {
    const upload = /\/jmap\/upload\/([^/]+)\//.exec(url);
    if (init.method === 'POST' && upload) {
      return Response.json({ accountId: upload[1], blobId: `upload-${upload[1]}-${++uploads}`, type: DOCX, size: 3 });
    }
    return new Response('DOCX-BYTES', { status: 200, headers: { 'Content-Length': '10' } });
  });
});

async function openShared() {
  const res = await launch(request('/api/wopi/launch', { body: { fileId: 'b', accountId: OWNER } }));
  expect(res.status).toBe(200);
  const data = await res.json();
  return { data, ...editorCall(data) };
}

describe('WOPI on a file shared with the user (#1094)', () => {
  it('launches editable from the owner account and the bare node id', async () => {
    const { data, documentId, token } = await openShared();
    expect(data.readOnly).toBe(false);

    const info = await checkFileInfo(request(`/api/wopi/files/${documentId}?${token}`), params(documentId));
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ BaseFileName: 'new-file.docx', UserCanWrite: true, Version: 'Gshared' });
  });

  it('GetFile reads the blob through the owner account', async () => {
    const { documentId, token } = await openShared();
    (fetchJmapServer as Mock).mockClear();
    const res = await getFile(request(`/api/wopi/files/${documentId}/contents?${token}`), params(documentId));
    expect(res.status).toBe(200);
    expect((fetchJmapServer as Mock).mock.calls[0][0]).toContain(`/jmap/download/${OWNER}/Gshared/`);
  });

  it('PutFile uploads into the own account and updates the node in the owner account', async () => {
    const { documentId, token } = await openShared();
    (fetchJmapServer as Mock).mockClear();
    const res = await putFile(
      request(`/api/wopi/files/${documentId}/contents?${token}`, { bytes: new TextEncoder().encode('new').buffer as ArrayBuffer }),
      params(documentId),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ LastModifiedTime: '2026-09-26T21:00:00Z' });

    const [uploadUrl, uploadInit] = (fetchJmapServer as Mock).mock.calls[0];
    expect(uploadInit.method).toBe('POST');
    expect(uploadUrl).toContain(`/jmap/upload/${OWN}/`);
    expect(setCalls).toEqual([{ accountId: OWNER, update: { b: { blobId: `upload-${OWN}-1` } } }]);
  });

  it('shares one editor session with the owner opening the same file', async () => {
    const { documentId } = await openShared();
    // The owner's own files account is the one the node lives in.
    (fetchJmapSession as Mock).mockResolvedValue({
      primaryAccounts: { 'urn:ietf:params:jmap:filenode': OWNER },
      accounts: { [OWNER]: { isPersonal: true } },
    });
    const res = await launch(request('/api/wopi/launch', { body: { fileId: 'b' } }));
    expect(editorCall(await res.json()).documentId).toBe(documentId);
  });
});
