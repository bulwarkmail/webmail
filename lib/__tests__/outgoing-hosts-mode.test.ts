// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { OUTGOING_HOSTS } from '@/lib/admin/outgoing-hosts-registry';
import {
  isBuiltInHost,
  mapsLinksAllowed,
  sampleAvatarsAllowed,
  senderFaviconsAllowed,
  wkdAllowed,
} from '@/lib/outgoing-hosts';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';

// Turns "no third-party traffic" on the way an admin does (config.json; the
// browser gets it from /api/config) and checks that every entry of the
// registry is then off, by asking the code that uses each host. A new entry
// without a probe here fails, so the registry can't list a host whose
// switch nobody checked (#903).

vi.hoisted(() => { process.env.NEXT_PUBLIC_APP_VERSION = '1.18.0'; });
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ serverUrl: 'https://mail.example.com', authHeader: 'Basic x', username: 'u' })),
}));
vi.mock('@/lib/security/same-origin', () => ({ rejectCrossOriginRequest: () => null }));
// The BIMI route would query real DNS; the probe only needs to see whether it gets that far.
const bimiResolve = vi.hoisted(() => vi.fn(async (_domain: string) => null));
vi.mock('@/lib/bimi/lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bimi/lookup')>()),
  bimiResolver: () => ({
    resolve: bimiResolve,
    answer: async (domain: string) => ({ indicator: await bimiResolve(domain), deferred: false }),
    clear: () => {},
  }),
}));

import { configManager } from '@/lib/admin/config-manager';

let dir: string;
const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => Response.json({ latest: '1.18.0' }));
const fetchedHosts = () => fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname);

async function setMode(on: boolean) {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(on ? { noThirdPartyTraffic: true } : {}));
  await configManager.load();
  // What the browser does with /api/config (hooks/use-config.ts).
  const { GET } = await import('@/app/api/config/route');
  const config = await (await GET(new NextRequest('https://webmail.example/api/config'))).json();
  setNoThirdPartyTraffic(config.noThirdPartyTraffic === true);
}

/** Whether the code behind each registry entry would reach its host right now. */
const probes: Record<string, () => Promise<boolean>> = {
  telemetry: async () => {
    const { effectiveConsent, loadState, saveState } = await import('@/lib/telemetry');
    await saveState({ ...(await loadState()), consent: 'on' });
    return (await effectiveConsent()).consent === 'on';
  },
  'version-check': async () => {
    const { checkOnce } = await import('@/lib/version-check');
    await checkOnce();
    return fetchedHosts().includes('version.telemetry.bulwarkmail.org');
  },
  'push-relay': async () => {
    const { resolvePushRelayOptions, resolveDefaultRelayUrl } = await import('@/lib/push-relays');
    return resolvePushRelayOptions({}).some((o) => isBuiltInHost(o.url)) || isBuiltInHost(resolveDefaultRelayUrl({}));
  },
  'extension-directory': async () => {
    const { directoryOff } = await import('@/lib/admin/marketplace-directory');
    return !(await directoryOff());
  },
  connector: async () => {
    const { GET } = await import('@/app/api/connector/capabilities/route');
    return (await GET()).status === 200;
  },
  favicons: async () => {
    const { GET } = await import('@/app/api/favicon/route');
    await GET(new NextRequest(`https://webmail.example/api/favicon?domain=probe${Date.now()}.org`));
    return fetchedHosts().includes('icons.duckduckgo.com') || senderFaviconsAllowed();
  },
  bimi: async () => {
    const { GET } = await import('@/app/api/bimi/route');
    bimiResolve.mockClear();
    await GET(new NextRequest('https://webmail.example/api/bimi?domain=probe.org'));
    return bimiResolve.mock.calls.length > 0;
  },
  'spellcheck-dictionaries': async () => {
    const { dictionaryDownloadAllowed } = await import('@/lib/desktop/dictionary-download');
    return dictionaryDownloadAllowed();
  },
  translate: async () => {
    const { POST } = await import('@/app/api/translate/route');
    await POST(new NextRequest('https://webmail.example/api/translate', {
      method: 'POST', body: JSON.stringify({ text: 'Hallo Welt', target: 'en', source: 'de' }),
    }));
    return fetchedHosts().includes('api.mymemory.translated.net');
  },
  maps: async () => mapsLinksAllowed(),
  wkd: async () => wkdAllowed(),
  'dev-avatars': async () => sampleAvatarsAllowed(),
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-3p-mode-'));
  process.env.ADMIN_CONFIG_DIR = dir;
  process.env.TELEMETRY_DATA_DIR = path.join(dir, 'telemetry');
  process.env.VERSION_CHECK_DATA_DIR = path.join(dir, 'version');
  delete process.env.NO_THIRD_PARTY_TRAFFIC;
});
afterAll(() => {
  setNoThirdPartyTraffic(false);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADMIN_CONFIG_DIR;
  delete process.env.TELEMETRY_DATA_DIR;
  delete process.env.VERSION_CHECK_DATA_DIR;
});
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('no third-party traffic mode', () => {
  it('has a probe for every registry entry', () => {
    expect(Object.keys(probes).sort()).toEqual(OUTGOING_HOSTS.map((h) => h.id).sort());
  });

  it.each(OUTGOING_HOSTS.map((h) => h.id))('%s is reachable with the mode off', async (id) => {
    await setMode(false);
    expect(await probes[id]()).toBe(true);
  });

  it.each(OUTGOING_HOSTS.map((h) => h.id))('%s is off with the mode on', async (id) => {
    await setMode(true);
    expect(await probes[id]()).toBe(false);
  });
});
