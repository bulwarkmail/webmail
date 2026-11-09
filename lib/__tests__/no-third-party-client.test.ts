import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELAY_BASE_URL, resolveActiveRelayUrl, resolveDefaultRelayUrl, resolvePushRelayOptions } from '@/lib/push-relays';
import { resyncWebPush, revokePushDevice, type PushDevice } from '@/lib/web-push';
import { doGetPublicKeyFromWKD } from '@/lib/plugin-sandbox/host-api';
import { applyLiteConfig } from '@/lib/lite-config';
import { setNoThirdPartyTraffic, noThirdPartyTraffic, parseNoThirdPartyEnv } from '@/lib/third-party-mode';
import { credentialAllowedInMode, isBuiltInHost, pluginAllowed, pluginDeclaresNetwork } from '@/lib/outgoing-hosts';
import { isPlaceholderHost } from '@/lib/admin/outgoing-hosts-registry';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The browser half of the "no third-party traffic" mode (#903).

const fetchSpy = vi.fn(async () => new Response('{}'));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setNoThirdPartyTraffic(false);
});

const ownRelay = { label: 'Company', url: 'https://push.company.example' };

describe('push relays', () => {
  it('drop the built-in relay in the mode and keep the admin\'s', () => {
    setNoThirdPartyTraffic(true);
    expect(resolvePushRelayOptions({})).toEqual([]);
    expect(resolvePushRelayOptions({ pushRelays: [ownRelay] })).toEqual([ownRelay]);
    setNoThirdPartyTraffic(false);
    expect(resolvePushRelayOptions({ pushRelays: [ownRelay] }).map((o) => o.url)).toEqual([DEFAULT_RELAY_BASE_URL, ownRelay.url]);
  });

  it('fall back to the admin\'s relay, or to none, instead of the built-in one', () => {
    setNoThirdPartyTraffic(true);
    expect(resolveDefaultRelayUrl({ pushRelays: [ownRelay] })).toBe(ownRelay.url);
    expect(resolveDefaultRelayUrl({})).toBe('');
    // A user's saved pick of the built-in relay is not honoured either.
    expect(resolveActiveRelayUrl({}, DEFAULT_RELAY_BASE_URL)).toBe('');
    expect(resolveActiveRelayUrl({ pushRelays: [ownRelay] }, DEFAULT_RELAY_BASE_URL)).toBe(ownRelay.url);
    // A configured pushRelayUrl pointing at the built-in host doesn't sneak it back.
    expect(resolveDefaultRelayUrl({ pushRelayUrl: DEFAULT_RELAY_BASE_URL })).toBe('');
    setNoThirdPartyTraffic(false);
    expect(resolveDefaultRelayUrl({})).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it('never get a request to the built-in relay in the mode', async () => {
    const client = { destroyPushSubscription: vi.fn(async () => {}) } as unknown as IJMAPClient;
    const device: PushDevice = { id: 'p1', deviceClientId: 'abc', expires: null, types: null, isThisDevice: false, relayStatus: 'unknown' };

    setNoThirdPartyTraffic(true);
    await revokePushDevice({ client, device, relayBaseUrl: DEFAULT_RELAY_BASE_URL });
    expect(client.destroyPushSubscription).toHaveBeenCalledWith('p1');
    expect(fetchSpy).not.toHaveBeenCalled();

    setNoThirdPartyTraffic(false);
    await revokePushDevice({ client, device, relayBaseUrl: DEFAULT_RELAY_BASE_URL });
    expect(fetchSpy).toHaveBeenCalledWith(`${DEFAULT_RELAY_BASE_URL}/api/push/register/abc`, { method: 'DELETE' });
  });
});

describe('push registrations made before the mode', () => {
  it('are removed from the mail server when no relay of the organisation is left', async () => {
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'granted' });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => undefined },
    });
    localStorage.setItem('bulwark.push.subscriptionId.v1.acc1', 'ps1');
    const client = {
      getAccountId: () => 'acc1',
      destroyPushSubscription: vi.fn(async () => {}),
      listPushSubscriptions: vi.fn(async () => []),
    } as unknown as IJMAPClient;
    try {
      setNoThirdPartyTraffic(true);
      await resyncWebPush({ client, relayBaseUrl: '', inboxOnly: false });
      expect(client.destroyPushSubscription).toHaveBeenCalledWith('ps1');
      expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      localStorage.clear();
    }
  });
});

describe('WKD key lookup', () => {
  it('asks the recipient\'s domain only with the mode off', async () => {
    setNoThirdPartyTraffic(true);
    expect(await doGetPublicKeyFromWKD('joe@vendor.example')).toMatchObject({ status: 'ERROR' });
    expect(fetchSpy).not.toHaveBeenCalled();

    setNoThirdPartyTraffic(false);
    fetchSpy.mockImplementation(async () => new Response('', { status: 404 }));
    await doGetPublicKeyFromWKD('joe@vendor.example');
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/openpgpkey\.vendor\.example\//);
  });
});

describe('plugins', () => {
  it('that declare network access are refused in the mode, the rest run', () => {
    const offline = { permissions: ['email:read', 'http:post'] };
    const fetcher = { permissions: ['http:fetch'], httpOrigins: ['https://api.vendor.example'] };
    const proxied = { permissions: ['http:proxy'] };
    const framer = { permissions: [], frameOrigins: ['https://www.youtube-nocookie.com'] };
    expect([offline, fetcher, proxied, framer].map(pluginDeclaresNetwork)).toEqual([false, true, true, true]);

    setNoThirdPartyTraffic(true);
    expect([offline, fetcher, proxied, framer].map(pluginAllowed)).toEqual([true, false, false, false]);
    setNoThirdPartyTraffic(false);
    expect([offline, fetcher, proxied, framer].map(pluginAllowed)).toEqual([true, true, true, true]);
  });
});

describe('config', () => {
  it('lets a plugin run that reaches only servers the admin entered, and no other', () => {
    setNoThirdPartyTraffic(true);
    const admin = (extra: Record<string, unknown>) => ({ label: 'x', scope: 'admin', secretKey: 's', ...extra });
    const linkCheck = { permissions: ['http:proxy'], credentials: { company: admin({ originKey: 'url' }), google: admin({ origin: 'https://safebrowsing.googleapis.com' }) } };
    const fixedOnly = { permissions: ['http:proxy'], credentials: { google: admin({ origin: 'https://safebrowsing.googleapis.com' }) } };
    const userAccount = { permissions: ['http:proxy'], credentials: { company: admin({ originKey: 'url' }), own: { label: 'x', scope: 'user' } } };
    const alsoFetches = { permissions: ['http:proxy', 'http:fetch'], httpOrigins: ['https://api.vendor.example'], credentials: { company: admin({ originKey: 'url' }) } };
    expect([linkCheck, fixedOnly, userAccount, alsoFetches].map(pluginAllowed)).toEqual([true, false, false, false]);
    expect(credentialAllowedInMode(linkCheck.credentials.company)).toBe(true);
    expect(credentialAllowedInMode(linkCheck.credentials.google)).toBe(false);
    setNoThirdPartyTraffic(false);
  });

  it('reads noThirdPartyTraffic from the Lite config.json', () => {
    expect(applyLiteConfig({}).noThirdPartyTraffic).toBe(false);
    expect(applyLiteConfig({ noThirdPartyTraffic: true }).noThirdPartyTraffic).toBe(true);
    // A string as in env counts too (#903 review).
    expect(applyLiteConfig({ noThirdPartyTraffic: 'yes' }).noThirdPartyTraffic).toBe(true);
    expect(applyLiteConfig({ noThirdPartyTraffic: 'off' }).noThirdPartyTraffic).toBe(false);
  });

  it('turns the browser switches on once the runtime config is fetched', async () => {
    vi.resetModules();
    const mode = await import('@/lib/third-party-mode');
    const { createConfig } = await import('./fixtures/config');
    fetchSpy.mockImplementation(async () => Response.json(createConfig({ noThirdPartyTraffic: true })));
    const { fetchConfig } = await import('@/hooks/use-config');
    await fetchConfig();
    expect(mode.noThirdPartyTraffic()).toBe(true);
  });

  it('parses the env spellings', () => {
    expect(['true', 'TRUE', '1', 'yes', 'on', ' on '].map(parseNoThirdPartyEnv)).toEqual([true, true, true, true, true, true]);
    expect(['false', '0', '', 'off', 'nope', undefined].map(parseNoThirdPartyEnv)).toEqual([false, false, false, false, false, false]);
    expect(noThirdPartyTraffic()).toBe(false);
  });
});

describe('host helpers', () => {
  it('know the built-in hosts and the placeholders', () => {
    expect(isBuiltInHost('https://notifications.relay.bulwarkmail.org/')).toBe(true);
    expect(isBuiltInHost('https://extensions.bulwarkmail.org')).toBe(true);
    expect(isBuiltInHost('https://extensions.corp.example')).toBe(false);
    expect(isBuiltInHost('not a url')).toBe(false);
    expect(['mail.example.com', 'x', 'stalwart.internal:8080', '10.0.0.5', '*.vimeo.com', 'acme.test'].every(isPlaceholderHost)).toBe(true);
    expect(['github.com', 'icons.duckduckgo.com', 'api.example.io'].some(isPlaceholderHost)).toBe(false);
  });
});

describe('before the config is known (#903 review)', () => {
  it('treats the mode as on', async () => {
    vi.resetModules();
    const mode = await import('@/lib/third-party-mode');
    const hosts = await import('@/lib/outgoing-hosts');
    expect(mode.thirdPartyModeState()).toBe('unknown');
    expect(mode.noThirdPartyTraffic()).toBe(true);
    expect(hosts.relayAllowed('https://notifications.relay.bulwarkmail.org')).toBe(false);
    expect(hosts.senderFaviconsAllowed()).toBe(false);
    expect(hosts.mapsLinksAllowed()).toBe(false);
    expect(hosts.pluginAllowed({ permissions: ['http:fetch'] })).toBe(false);
    mode.setNoThirdPartyTraffic(false);
    expect(hosts.relayAllowed('https://notifications.relay.bulwarkmail.org')).toBe(true);
  });

  it.each([
    ['missing', async () => new Response('', { status: 404 })],
    ['not JSON', async () => new Response('{ this is not json', { status: 200 })],
  ])('turns the mode on in Lite when config.json is %s', async (_label, answer) => {
    vi.resetModules();
    vi.doMock('@/lib/lite', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/lite')>()), IS_LITE: true, IS_LITE_STALWART: false }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockImplementation(answer as never);
    try {
      const mode = await import('@/lib/third-party-mode');
      const { fetchConfig } = await import('@/hooks/use-config');
      expect((await fetchConfig()).noThirdPartyTraffic).toBe(true);
      expect(mode.thirdPartyModeState()).toBe('on');
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/no third-party traffic/);
    } finally {
      vi.doUnmock('@/lib/lite');
      warn.mockRestore();
    }
  });
});
