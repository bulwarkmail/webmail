/**
 * api.composer.registerChecker inside the sandbox: the plugin's functions
 * stay in its frame, only the data goes to the host, and the host's
 * `checker:<id>` calls reach the plugin's check function.
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

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
const g = globalThis as { __pluginApi?: { composer: { registerChecker(def: unknown): Promise<unknown> } } };

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

const sentOfType = (type: string) => hostWindow.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === type);

async function boot(mode: 'background' | 'slot') {
  const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
  render(React.createElement(SandboxRuntime));
  const code = mode === 'background'
    ? `module.exports = { activate: function (api) { globalThis.__pluginApi = api; } };`
    : `module.exports = { slots: { 'email-banner': { component: function () { globalThis.__pluginApi = require('@plugin-host'); return null; } } } };`;
  post(hostWindow, HOST_ORIGIN, {
    type: 'init',
    payload: {
      mode, pluginId: 'lt', tier: 'privileged', locale: 'en', slot: 'email-banner',
      manifest: { id: 'lt', version: '1.0.0', permissions: ['compose:check'], settings: {} },
      code, extraProps: {}, theme: { dark: false, fontFamily: 'sans-serif', vars: {} },
    },
  });
  // A slot frame loads its renderer first.
  await waitFor(() => expect(g.__pluginApi).toBeDefined(), { timeout: 20_000 });
  return g.__pluginApi!;
}

describe('registerChecker in the sandbox', () => {
  it('sends only data to the host and answers the host\'s check calls with the plugin\'s function', async () => {
    const api = await boot('background');
    const check = vi.fn(async (req: { segments: { id: string }[] }) => [{ segmentId: req.segments[0].id, offset: 0, length: 3, kind: 'spelling', message: 'Typo' }]);
    const registering = api.composer.registerChecker({ id: 'lt', label: 'LT', kinds: ['spelling'], check });
    await waitFor(() => expect(sentOfType('api-request').some((m) => m.method === 'composer.registerChecker')).toBe(true));
    const req = sentOfType('api-request').find((m) => m.method === 'composer.registerChecker');
    expect(req.args).toEqual([{ id: 'lt', label: 'LT', kinds: ['spelling'] }]);
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: req.id, ok: true, result: true });
    const handle = await registering as { id: string };
    expect(handle.id).toBe('lt');

    post(hostWindow, HOST_ORIGIN, { type: 'hook-invoke', id: 'h1', hookName: 'checker:lt', args: [{ segments: [{ id: 's1', text: 'teh' }] }] });
    await waitFor(() => expect(sentOfType('hook-result').some((m) => m.id === 'h1')).toBe(true));
    expect(sentOfType('hook-result').find((m) => m.id === 'h1')).toMatchObject({ ok: true, result: [{ segmentId: 's1', kind: 'spelling' }] });
    expect(check).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('refuses in a slot frame and without a check function', async () => {
    const api = await boot('slot');
    await expect(api.composer.registerChecker({ id: 'lt', label: 'LT', kinds: ['spelling'], check: () => [] })).rejects.toThrow('not from a slot');
    expect(sentOfType('api-request').some((m) => m.method === 'composer.registerChecker')).toBe(false);
  }, 30_000);

  it('needs a check function unless the checker is on demand', async () => {
    const api = await boot('background');
    await expect(api.composer.registerChecker({ id: 'lt', label: 'LT', kinds: ['spelling'] })).rejects.toThrow('check must be a function');
  }, 30_000);
});
