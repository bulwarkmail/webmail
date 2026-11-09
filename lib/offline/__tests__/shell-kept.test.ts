/**
 * Turning offline mode on keeps the app shell before it says it's on: a user
 * who loses the network a moment later still starts from it after a reload.
 * On a first visit the worker isn't registered yet (it waits for the first
 * screen), so turning the shell on registers it and waits for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: async () => new Response(JSON.stringify({ buildId: 'build-1', files: ['/_next/static/a.js'] })),
  withBasePath: (path: string) => path,
}));
vi.mock('@/lib/app-update', () => ({
  currentBuildId: () => 'build-1',
  SW_SCOPE: '/',
  serviceWorkerUrl: () => '/sw.js?v=build-1',
  adoptWaitingWorker: vi.fn(),
  announceBuildToServiceWorker: vi.fn(),
}));

const { tellServiceWorker } = await import('../shell');

let posted: { message: { type: string; on: boolean; urls: string[] }; ports: MessagePort[] }[] = [];
const worker = {
  postMessage: (message: { type: string; on: boolean; urls: string[] }, ports: MessagePort[] = []) => { posted.push({ message, ports }); },
};
let register: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posted = [];
  delete (window as unknown as Record<string, unknown>).__bulwarkSwRegistering;
  register = vi.fn(async () => ({ active: null }));
  vi.stubGlobal('navigator', {
    serviceWorker: {
      // Not registered yet: a first visit before the first screen was up.
      getRegistration: async () => undefined,
      register,
      ready: Promise.resolve({ active: worker }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('turning the app shell on', () => {
  it('registers the worker when this page has none yet, and tells it', async () => {
    const done = tellServiceWorker(true);
    await settle();
    expect(register).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toMatchObject({ type: 'offline-shell', on: true });
    expect(posted[0].message.urls).toContain('/_next/static/a.js');
    posted[0].ports[0].postMessage({ type: 'offline-shell-kept' });
    await done;
  });

  it('resolves only once the worker has kept the shell', async () => {
    let finished = false;
    const done = tellServiceWorker(true).then(() => { finished = true; });
    await settle();
    await settle();
    expect(finished).toBe(false);
    posted[0].ports[0].postMessage({ type: 'offline-shell-kept' });
    await done;
    expect(finished).toBe(true);
  });

  it('turns it off without registering a worker just for that', async () => {
    await tellServiceWorker(false);
    expect(register).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
});
