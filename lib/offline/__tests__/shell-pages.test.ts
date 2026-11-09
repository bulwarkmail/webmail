import { afterEach, describe, expect, it, vi } from 'vitest';

// A mailto: or webcal: launch without a connection needs its handler page in
// the app shell. Its address is what opens the draft; the start page alone
// doesn't read it outside an installed app.

vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: async () => new Response(JSON.stringify({ buildId: 'build-1', files: ['/_next/static/a.js'] })),
  withBasePath: (path: string) => path,
}));
vi.mock('@/lib/app-update', () => ({ currentBuildId: () => 'build-1', SW_SCOPE: '/' }));

const { tellServiceWorker } = await import('../shell');

afterEach(() => vi.unstubAllGlobals());

describe('app shell pages', () => {
  it('includes the protocol handler pages', async () => {
    // The worker says when it has kept the shell (lib/offline/shell.ts waits for it).
    const postMessage = vi.fn((_message: { urls: string[] }, ports?: MessagePort[]) => ports?.[0]?.postMessage({ type: 'offline-shell-kept' }));
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ active: { postMessage } }) } });

    await tellServiceWorker(true);

    expect(postMessage.mock.calls[0][0].urls).toEqual(expect.arrayContaining(['/', '/protocol/mailto', '/protocol/webcal']));
  });
});
