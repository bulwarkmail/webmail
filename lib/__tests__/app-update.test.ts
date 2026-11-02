import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lite = vi.hoisted(() => ({ IS_LITE: false, LITE_BUILD_ID: '' }));
vi.mock('@/lib/lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lite')>();
  return {
    ...actual,
    get IS_LITE() { return lite.IS_LITE; },
    get LITE_BUILD_ID() { return lite.LITE_BUILD_ID; },
  };
});

import { adoptWaitingWorker, currentBuildId, fetchDeployedBuildId, isChunkLoadFailure, newerBuildId, serviceWorkerUrl } from '../app-update';

function answer(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as Response);
}

describe('app update', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'build-a');
    lite.IS_LITE = false;
    lite.LITE_BUILD_ID = '';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('registers the service worker with the build id', () => {
    expect(currentBuildId()).toBe('build-a');
    expect(serviceWorkerUrl()).toBe('/sw.js?v=build-a');
  });

  it('asks /api/version which build the server runs', async () => {
    const fetchMock = answer({ buildId: 'build-b' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDeployedBuildId()).toBe('build-b');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/version');
    expect(await newerBuildId()).toBe('build-b');
  });

  it('offers nothing while the server runs this build, or cannot be asked', async () => {
    vi.stubGlobal('fetch', answer({ buildId: 'build-a' }));
    expect(await newerBuildId()).toBeNull();
    vi.stubGlobal('fetch', answer({}, false));
    expect(await newerBuildId()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await newerBuildId()).toBeNull();
  });

  it('reads lite-build.json in Lite', async () => {
    lite.IS_LITE = true;
    lite.LITE_BUILD_ID = '1.20.0-abc-x1';
    const fetchMock = answer({ buildId: '1.20.0-def-x2' });
    vi.stubGlobal('fetch', fetchMock);
    expect(currentBuildId()).toBe('1.20.0-abc-x1');
    expect(await newerBuildId()).toBe('1.20.0-def-x2');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/^\/lite-build\.json\?t=\d+$/);
  });

  it('recognises a chunk of a build that is gone', () => {
    const script = document.createElement('script');
    script.src = 'https://mail.example.com/_next/static/chunks/abc.js';
    expect(isChunkLoadFailure({ target: script } as unknown as Event)).toBe(true);
    const img = document.createElement('img');
    img.src = 'https://mail.example.com/_next/static/media/x.png';
    expect(isChunkLoadFailure({ target: img } as unknown as Event)).toBe(false);
    const other = document.createElement('script');
    other.src = 'https://cdn.example.com/x.js';
    expect(isChunkLoadFailure({ target: other } as unknown as Event)).toBe(false);
    const error = Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' });
    expect(isChunkLoadFailure({ reason: error } as unknown as PromiseRejectionEvent)).toBe(true);
    expect(isChunkLoadFailure({ reason: new Error('nope') } as unknown as PromiseRejectionEvent)).toBe(false);
  });

  it('lets a waiting worker of this tab’s build take over, and no other', () => {
    const worker = (v: string) => ({ scriptURL: `https://mail.example.com/sw.js?v=${v}`, postMessage: vi.fn() });
    const ours = worker('build-a');
    adoptWaitingWorker({ waiting: ours, addEventListener: () => {} } as unknown as ServiceWorkerRegistration);
    expect(ours.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' });
    const other = worker('build-b');
    adoptWaitingWorker({ waiting: other, addEventListener: () => {} } as unknown as ServiceWorkerRegistration);
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it('also when the worker of this tab’s build was still installing', () => {
    const listeners: Array<() => void> = [];
    const installing = { scriptURL: 'https://mail.example.com/sw.js?v=build-a', state: 'installing', postMessage: vi.fn(), addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
    const registration = { waiting: null as unknown, installing, addEventListener: () => {} };
    adoptWaitingWorker(registration as unknown as ServiceWorkerRegistration);
    expect(installing.postMessage).not.toHaveBeenCalled();
    installing.state = 'installed';
    registration.waiting = installing;
    listeners.forEach((fn) => fn());
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' });
  });
});
