/**
 * api.http.eventSource inside the sandbox: the plugin's callbacks stay in
 * its frame, the host is asked once, and what the host posts for the
 * subscription reaches the callbacks until it is closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';

const HOST_ORIGIN = window.location.origin;

function post(source: unknown, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

interface Source { close(): void }
interface Api { http: { eventSource(url: string, init: unknown): Promise<Source> } }

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
const g = globalThis as { __pluginApi?: Api };

beforeEach(() => {
  vi.resetModules();
  hostWindow = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, get: () => hostWindow as unknown as Window });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete g.__pluginApi;
  if (realParent) Object.defineProperty(window, 'parent', realParent);
});

const requests = (method: string) => hostWindow.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === 'api-request' && m.method === method);

async function boot(): Promise<Api> {
  const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
  render(React.createElement(SandboxRuntime));
  post(hostWindow, HOST_ORIGIN, {
    type: 'init',
    payload: {
      mode: 'background', pluginId: 'calls', tier: 'untrusted', locale: 'en',
      manifest: { id: 'calls', version: '1.0.0', permissions: ['http:fetch'], settings: {}, httpOrigins: ['https://api.example.com'] },
      code: 'module.exports = { activate: function (api) { globalThis.__pluginApi = api; } };',
    },
  });
  await waitFor(() => expect(g.__pluginApi).toBeDefined(), { timeout: 20_000 });
  return g.__pluginApi!;
}

describe('eventSource in the sandbox', () => {
  it('asks the host once and hands its events to the plugin until closed', async () => {
    const api = await boot();
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const opening = api.http.eventSource('https://api.example.com/events', { headers: { Authorization: 'Bearer t' }, onEvent, onOpen, onError });
    await waitFor(() => expect(requests('http.openEventStream')).toHaveLength(1));
    const req = requests('http.openEventStream')[0];
    const { streamId } = req.args[1];
    // Only data crosses to the host: the address, the headers, the id.
    expect(req.args).toEqual(['https://api.example.com/events', { headers: { Authorization: 'Bearer t' }, streamId }]);
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: req.id, ok: true });
    const source = await opening;

    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'open' } });
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'event', type: 'ringing', data: '[1]', lastEventId: '4' } });
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'error', message: 'connection reset', closed: false } });
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId: 'someoneelses', event: { kind: 'event', type: 'x', data: 'no', lastEventId: '' } });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls).toEqual([[{ type: 'ringing', data: '[1]', lastEventId: '4' }]]);
    expect(onError.mock.calls).toEqual([[{ message: 'connection reset', closed: false }]]);

    source.close();
    source.close();
    expect(requests('http.closeEventStream').map((m) => m.args)).toEqual([[streamId]]);
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'event', type: 'ringing', data: '[]', lastEventId: '' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('rejects when the host refuses, and forgets a subscription the host gave up', async () => {
    const api = await boot();
    const refused = api.http.eventSource('https://evil.example/events', { onEvent: () => {} });
    await waitFor(() => expect(requests('http.openEventStream')).toHaveLength(1));
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: requests('http.openEventStream')[0].id, ok: false, error: 'Origin https://evil.example not in plugin httpOrigins allowlist' });
    await expect(refused).rejects.toThrow(/not in plugin httpOrigins/);

    const onEvent = vi.fn();
    const onError = vi.fn();
    const opening = api.http.eventSource('https://api.example.com/events', { onEvent, onError });
    await waitFor(() => expect(requests('http.openEventStream')).toHaveLength(2));
    const req = requests('http.openEventStream')[1];
    const { streamId } = req.args[1];
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: req.id, ok: true });
    const source = await opening;
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'error', message: 'The server answered 401', status: 401, closed: true } });
    expect(onError.mock.calls).toEqual([[{ message: 'The server answered 401', status: 401, closed: true }]]);
    post(hostWindow, HOST_ORIGIN, { type: 'event-stream', streamId, event: { kind: 'event', type: 'x', data: 'late', lastEventId: '' } });
    expect(onEvent).not.toHaveBeenCalled();
    // Nothing left to close on the host.
    source.close();
    expect(requests('http.closeEventStream')).toHaveLength(0);
  }, 30_000);

  it('needs an onEvent function', async () => {
    const api = await boot();
    await expect(api.http.eventSource('https://api.example.com/events', {})).rejects.toThrow('onEvent must be a function');
    expect(requests('http.openEventStream')).toHaveLength(0);
  }, 30_000);
});
