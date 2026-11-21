import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-navigation')>()),
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { dispatchApiCall, PLUGIN_STORAGE_QUOTA_BYTES, safeDownloadName, doGetPublicKeyFromWKD, getWkdHash } from '../plugin-sandbox/host-api';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'limits', name: 'Limits', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('plugin storage quota', () => {
  it('refuses a write that would take the plugin past its share', async () => {
    // Without a cap one plugin could fill localStorage and break sign-in.
    const half = 'x'.repeat(PLUGIN_STORAGE_QUOTA_BYTES / 2);
    await dispatchApiCall(plugin(), 'storage.set', ['a', half]);

    await expect(dispatchApiCall(plugin(), 'storage.set', ['b', half])).rejects.toThrow(/storage is full/);
  });

  it('lets a plugin overwrite a key within its share', async () => {
    const big = 'x'.repeat(PLUGIN_STORAGE_QUOTA_BYTES * 0.8);
    await dispatchApiCall(plugin(), 'storage.set', ['a', big]);
    await expect(dispatchApiCall(plugin(), 'storage.set', ['a', big])).resolves.toBeUndefined();
  });
});

describe('ui.downloadFile', () => {
  const p = plugin({ permissions: ['ui:download-file'], grantedPermissions: ['ui:download-file'] });

  it.each([
    ['invoice.pdf.exe', 'application/pdf'],
    ['page.html', 'text/plain'],
    ['report.txt', 'text/html'],
    ['logo.svg', 'image/svg+xml'],
  ])('refuses %s (%s)', async (filename, contentType) => {
    await expect(dispatchApiCall(p, 'ui.downloadFile', [{ content: 'x', filename, contentType }]))
      .rejects.toThrow(/can't be downloaded/);
  });

  it('strips paths and direction tricks from the name', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeDownloadName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(safeDownloadName('')).toBe('download');
  });
});

describe('toasts', () => {
  it('caps how many toasts a plugin shows in a burst', async () => {
    for (let i = 0; i < 20; i++) await dispatchApiCall(plugin(), 'toast.info', [`n${i}`]);
    expect(toast.info).toHaveBeenCalledTimes(5);
  });

  it('shortens very long messages', async () => {
    await dispatchApiCall(plugin({ id: 'long' }), 'toast.error', ['x'.repeat(5000)]);
    expect((toast.error.mock.calls[0][0] as string).length).toBeLessThanOrEqual(300);
  });
});

describe('admin config writes', () => {
  it('tells the plugin when the server refused the write', async () => {
    // A 403 used to look like success.
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    const p = plugin({ permissions: ['admin:config'], grantedPermissions: ['admin:config'] });
    await expect(dispatchApiCall(p, 'admin.setConfig', ['k', 'v'])).rejects.toThrow(/only an administrator/);
  });
});

describe('WKD lookup', () => {
  it('refuses an address whose domain is not a host name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await doGetPublicKeyFromWKD('a@evil.example/x?')).toMatchObject({ status: 'ERROR' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('tries the advanced, direct and fallback URLs in order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await doGetPublicKeyFromWKD('Joe.Doe@example.org')).toMatchObject({ status: 'NOT_FOUND' });
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      'https://openpgpkey.example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    ]);
    fetchSpy.mockRestore();
  });
});

describe('WKD hash', () => {
  it('matches the RFC example (Joe.Doe)', async () => {
    // draft-koch-openpgp-webkey-service: "Joe.Doe" → iy9q119eutrkn8s1mk4r39qejnbu3n5q
    expect(await getWkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
  });
});

describe('api.user.getTimeZone', () => {
  it('gives the zone the app shows times in', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' } as never);
    expect(await dispatchApiCall(plugin(), 'user.getTimeZone', [])).toBe('Asia/Tokyo');
    useSettingsStore.setState({ timeZone: 'auto' } as never);
    expect(await dispatchApiCall(plugin(), 'user.getTimeZone', [])).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
