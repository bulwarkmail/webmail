// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Organisation > Devices, held by the office editor: CheckFileInfo tells
// Collabora and ONLYOFFICE to turn print and export off and to show the
// watermark, for the login's own scopes.

vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 'x'.repeat(32), hasSessionSecret: () => true }));
vi.mock('@/lib/logger', () => ({ logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
const policy = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (_key: string, fallback: unknown) => fallback, ensureLoaded: async () => {}, getPolicy: () => policy.current },
}));
vi.mock('@/lib/wopi/discovery', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/wopi/discovery')>()),
  getWopiActions: vi.fn(),
}));
vi.mock('@/lib/stalwart/server-fetch', () => ({ fetchJmapServer: vi.fn(), isTrustedJmapServerUrl: async () => true }));
vi.mock('@/lib/stalwart/jmap-api', () => ({ fetchJmapSession: vi.fn(), postJmap: vi.fn(), rebaseApiUrl: () => null }));

import { POST as launch } from '@/app/api/wopi/launch/route';
import { GET as checkFileInfo } from '@/app/api/wopi/files/[fileId]/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getWopiActions } from '@/lib/wopi/discovery';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { clearServerDeviceSubjects, wopiDeviceInfo } from '@/lib/admin/server-device-policy';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';

process.env.ADMIN_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'bw-wopi-dev-'));

const ORIGIN = 'https://webmail.example.com';
const OFFICE = 'https://office.example.com/browser/abc/cool.html?';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function request(url: string, init: { body?: unknown } = {}) {
  return { nextUrl: new URL(url, ORIGIN), headers: new Headers(), json: async () => init.body, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Parameters<typeof launch>[0];
}
const params = (id: string) => ({ params: Promise.resolve({ fileId: id }) });

async function fileInfo(): Promise<Record<string, unknown>> {
  const launched = await (await launch(request('/api/wopi/launch', { body: { blobId: 'Gblob1', name: 'Quote.docx', type: DOCX } }))).json();
  const wopiSrc = new URL(new URL(launched.url).searchParams.get('WOPISrc')!);
  const documentId = decodeURIComponent(wopiSrc.pathname.split('/').pop()!);
  const res = await checkFileInfo(request(`/api/wopi/files/${documentId}?access_token=${encodeURIComponent(launched.accessToken)}`), params(documentId));
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearServerDeviceSubjects();
  (getStalwartCredentials as Mock).mockResolvedValue({
    serverUrl: 'https://mail.example.com', authHeader: 'Basic dXNlcjpwYXNz', username: 'user@example.com', trusted: true, slot: 0, hasSessionCookie: true,
  });
  (getWopiActions as Mock).mockResolvedValue({ edit: { docx: OFFICE }, view: {} });
  (fetchJmapSession as Mock).mockResolvedValue({
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
    accounts: { c: { name: 'user@example.com', isPersonal: true }, g: { name: 'sales@example.com', isPersonal: false } },
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  });
  (fetchJmapServer as Mock).mockImplementation(async () => new Response('DOCX', { status: 200, headers: { 'Content-Length': '4' } }));
});

describe('office editor under the device policies', () => {
  it('says nothing extra while the policies are off', async () => {
    policy.current = { ...DEFAULT_POLICY };
    const info = await fileInfo();
    expect(info.DisablePrint).toBeUndefined();
    expect(info.DisableExport).toBeUndefined();
    expect(info.WatermarkText).toBeUndefined();
  });

  it('turns print and export off and adds the watermark for a group scope from the session', async () => {
    policy.current = {
      ...DEFAULT_POLICY,
      scopes: [{ id: 's', label: 'Sales', match: { groups: ['sales@example.com'] }, policy: { organisation: { devices: { noPrint: true, noDownloads: true, watermark: true } } } }],
    };
    const info = await fileInfo();
    expect(info).toMatchObject({ DisablePrint: true, HidePrintOption: true, DisableExport: true, HideExportOption: true, HideSaveOption: true });
    expect(info.WatermarkText).toMatch(/^user@example\.com · \d{4}-\d{2}-\d{2}$/);
  });
});

describe('office editor when the policy or session can’t be read', () => {
  it('turns everything off when the policy can’t be read', async () => {
    policy.current = null as never;
    const info = await fileInfo();
    expect(info).toMatchObject({ DisablePrint: true, DisableExport: true, HideSaveOption: true });
  });

  it('applies every scope’s switch when the session can’t be read', async () => {
    policy.current = {
      ...DEFAULT_POLICY,
      scopes: [{ id: 'x', label: 'X', match: { groups: ['other@example.com'] }, policy: { organisation: { devices: { noPrint: true } } } }],
    };
    (fetchJmapSession as Mock).mockResolvedValueOnce({
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' }, accounts: { c: {} },
      downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    }).mockResolvedValueOnce(null);
    const info = await fileInfo();
    expect(info).toMatchObject({ DisablePrint: true });
    expect(info.DisableExport).toBeUndefined();
  });
});

describe('wopiDeviceInfo', () => {
  it('maps each switch', () => {
    const off = DEFAULT_ORGANISATION_POLICY.devices;
    expect(wopiDeviceInfo(off, 'a@x')).toEqual({});
    expect(wopiDeviceInfo({ ...off, noExport: true }, 'a@x')).toMatchObject({ DisableExport: true, HideSaveOption: true });
    expect(wopiDeviceInfo({ ...off, noPrint: true }, 'a@x')).toEqual({ DisablePrint: true, HidePrintOption: true });
  });
});
