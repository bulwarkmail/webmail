import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  fetchPolicy: vi.fn(),
}));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/policy-store', () => ({
  usePolicyStore: { getState: () => ({ fetchPolicy: mocks.fetchPolicy }) },
}));

const config = createConfig();
const success = () => Response.json(config);
const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.apiFetch.mockReset();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '0');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('server configuration recovery', () => {
  it('caches a successful first response without leaving a timeout', async () => {
    mocks.apiFetch.mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    expect(await fetchConfig()).toEqual(config);
    expect(await fetchConfig()).toEqual(config);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPolicy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers from an interrupted request, sharing retries and the successful cache', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    // Observe rejection immediately so this also reports a clean regression on
    // the old one-shot loader, without an unhandled promise rejection.
    const first = fetchConfig().then(value => ({ value }), error => ({ error: error.message }));
    const second = fetchConfig().then(value => ({ value }), error => ({ error: error.message }));
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ value: config });
    expect(await second).toEqual({ value: config });
    expect(await fetchConfig()).toEqual(config);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/config', expect.objectContaining({ cache: 'no-store' }));
    expect(mocks.fetchPolicy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits between attempts instead of immediately repeating failed requests', async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
      .mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    const pending = fetchConfig();
    await vi.advanceTimersByTimeAsync(499);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(await pending).toEqual(config);
  });

  it('retries incomplete configuration without caching it or fetching policy', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(Response.json({ appName: config.appName, jmapServerUrl: config.jmapServerUrl }))
      .mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    const pending = fetchConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchPolicy).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(config);
    expect(await fetchConfig()).toEqual(config);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('recovers from wrong-typed fields and malformed nested server entries', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(Response.json({ ...config, oauthOnly: 'false' }))
      .mockResolvedValueOnce(Response.json({ ...config, jmapServers: [{ id: 'a', url: 'https://mail.example.com' }] }))
      .mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    const pending = fetchConfig();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(config);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
  });

  it('recovers when an intermediary serves HTML or an error object with HTTP 200', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(new Response('<html>Gateway error</html>'))
      .mockResolvedValueOnce(Response.json({ error: 'temporarily unavailable' }))
      .mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    const pending = fetchConfig();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(config);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
  });

  it('bounds repeated failures and permits a later fresh request', async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError('Network unavailable'));
    const { fetchConfig } = await import('../use-config');
    const failed = expect(fetchConfig()).rejects.toThrow('Network unavailable');
    await vi.runAllTimersAsync();
    await failed;
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetchPolicy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    mocks.apiFetch.mockResolvedValueOnce(success());
    expect(await fetchConfig()).toEqual(config);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'])('times out stalled response %s and recovers with a fresh signal', async phase => {
    mocks.apiFetch.mockImplementationOnce((_url, options) => {
      const stalled = untilAborted(options!.signal!);
      if (phase === 'headers') return stalled;
      const response = new Response();
      vi.spyOn(response, 'json').mockImplementation(() => stalled);
      return Promise.resolve(response);
    }).mockResolvedValueOnce(success());
    const { fetchConfig } = await import('../use-config');
    const pending = fetchConfig();
    await vi.advanceTimersByTimeAsync(9999);
    const firstSignal = mocks.apiFetch.mock.calls[0][1]!.signal!;
    expect(firstSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSignal.aborted).toBe(true);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual(config);
    const secondSignal = mocks.apiFetch.mock.calls[1][1]!.signal!;
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates when every attempt stalls instead of leaving a permanent spinner', async () => {
    mocks.apiFetch.mockImplementation((_url, options) => untilAborted(options!.signal!));
    const { fetchConfig } = await import('../use-config');
    const failed = expect(fetchConfig()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(32000);
    await failed;
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(mocks.apiFetch.mock.calls.every(([, options]) => options!.signal!.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps mounted consumers loading through recovery when another consumer unmounts', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(success());
    const { useConfig } = await import('../use-config');
    const first = renderHook(() => useConfig());
    const second = renderHook(() => useConfig());
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(second.result.current).toMatchObject({ isLoading: true, error: null });
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(second.result.current).toEqual({ ...config, isLoading: false, error: null });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('shows the error state only after all attempts fail', async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError('Network unavailable'));
    const { useConfig } = await import('../use-config');
    const { result } = renderHook(() => useConfig());
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(result.current).toMatchObject({ isLoading: true, error: null });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current).toMatchObject({ isLoading: false, error: 'Network unavailable' });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Lite configuration compatibility', () => {
  it('preserves static defaults when its optional config is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
    vi.stubEnv('NEXT_PUBLIC_LITE_TARGET', 'static');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.apiFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { fetchConfig } = await import('../use-config');
    const data = await fetchConfig();
    expect(data.appName).toBe('Webmail');
    expect(data.allowCustomJmapEndpoint).toBe(true);
    expect(mocks.apiFetch).toHaveBeenCalledExactlyOnceWith('/config.json', { cache: 'no-store' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Stalwart config build-versioned and accepts partial deployer settings', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
    vi.stubEnv('NEXT_PUBLIC_LITE_TARGET', 'stalwart');
    vi.stubEnv('NEXT_PUBLIC_LITE_BUILD_ID', 'test-build');
    mocks.apiFetch.mockResolvedValueOnce(Response.json({ appName: 'Stalwart Mail' }));
    const { fetchConfig } = await import('../use-config');
    const data = await fetchConfig();
    expect(data.appName).toBe('Stalwart Mail');
    expect(data.jmapServerUrl).toBe(window.location.origin);
    expect(data.allowCustomJmapEndpoint).toBe(false);
    expect(mocks.apiFetch).toHaveBeenCalledExactlyOnceWith('/config.json?v=test-build', undefined);
    expect(vi.getTimerCount()).toBe(0);
  });
});
