/**
 * api.keystore in the sandbox runtime. A PIN prompt can take minutes, so the facade
 * must not give up after the RPC's usual 30 seconds, and errors have to reach the
 * plugin as the bare code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const HOST_ORIGIN = window.location.origin;

function post(source: unknown, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin: HOST_ORIGIN });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

interface KeystoreFacade {
  list(options?: { quiet?: boolean }): Promise<unknown>;
  sign(id: string, signedAttributes: Uint8Array, scheme: unknown): Promise<Uint8Array>;
  decrypt(id: string, data: Uint8Array, scheme: unknown, options?: { quiet?: boolean }): Promise<Uint8Array>;
  agree(id: string, peer: Uint8Array, options?: { quiet?: boolean }): Promise<Uint8Array>;
}

describe('api.keystore in the sandbox', () => {
  let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
  const g = globalThis as { __pluginApi?: { keystore: KeystoreFacade; host: { features: Record<string, boolean> } } };

  beforeEach(() => {
    vi.resetModules();
    hostWindow = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, get: () => hostWindow as unknown as Window });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
    delete g.__pluginApi;
    if (realParent) Object.defineProperty(window, 'parent', realParent);
  });

  const requests = () =>
    hostWindow.postMessage.mock.calls.map((call) => call[0] as { type: string; id: string; method: string; args: unknown[] }).filter((message) => message.type === 'api-request');

  async function boot(features: Record<string, boolean>): Promise<void> {
    const bundle = 'module.exports = { activate: function (api) { globalThis.__pluginApi = api; } };';
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));
    post(hostWindow, {
      type: 'init',
      payload: {
        mode: 'background', pluginId: 'smime', tier: 'privileged', locale: 'en',
        manifest: { id: 'smime', version: '1.0.0', permissions: ['crypto:full', 'keystore'], settings: {} },
        code: bundle,
        hostFeatures: { externalSenderLabel: false, externalRecipientWarning: false, noThirdPartyTraffic: false, ...features },
      },
    });
    await waitFor(() => expect(g.__pluginApi).toBeDefined());
  }

  it('the flag reaches the plugin, and is not there when the host does not send it', async () => {
    await boot({ keystore: true });
    expect(g.__pluginApi!.host.features.keystore).toBe(true);
    post(hostWindow, { type: 'host-change', features: { externalSenderLabel: false, externalRecipientWarning: false, noThirdPartyTraffic: false } });
    expect(g.__pluginApi!.host.features.keystore).toBeFalsy();
  }, 30_000);

  it('a list has the ordinary RPC timeout: it never waits on a card', async () => {
    await boot({ keystore: true });
    vi.useFakeTimers();
    const listing = g.__pluginApi!.keystore.list();
    const outcome = listing.then(() => 'answered', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(outcome).resolves.toMatch(/timed out/);
  }, 30_000);

  it('no key operation gives up while the host has not answered: a PIN can take minutes', async () => {
    await boot({ keystore: true });
    vi.useFakeTimers();
    const api = g.__pluginApi!.keystore;
    const digest = new Uint8Array(32);
    const settled: string[] = [];
    const watch = (name: string, promise: Promise<unknown>) => promise.then(() => settled.push(name), () => settled.push(`${name} rejected`));
    watch('sign', api.sign('id', digest, { scheme: 'rsa-pkcs1', hash: 'SHA-256' }));
    watch('decrypt', api.decrypt('id', new Uint8Array(256), { scheme: 'rsa-pkcs1' }));
    watch('agree', api.agree('id', new Uint8Array(91)));
    // Past the RPC's 30 s and past the network calls' 120 s.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toEqual([]);
    expect(requests().map((request) => request.method)).toEqual(['keystore.sign', 'keystore.decrypt', 'keystore.agree']);
  }, 30_000);

  it('passes the bytes as bytes, and hands an error back with the code as its message', async () => {
    await boot({ keystore: true });
    const api = g.__pluginApi!.keystore;
    const digest = new Uint8Array(32).fill(9);
    const scheme = { scheme: 'rsa-pss', hash: 'SHA-256' };
    const signing = api.sign('the-id', digest, scheme);
    const sent = requests().at(-1)!;
    expect(sent.args).toEqual(['the-id', digest, scheme]);
    void api.list({ quiet: true }).catch(() => {});
    expect(requests().at(-1)!.args).toEqual([{ quiet: true }]);
    void api.decrypt('the-id', new Uint8Array(4), { scheme: 'rsa-pkcs1' }, { quiet: true }).catch(() => {});
    expect(requests().at(-1)!.args).toEqual(['the-id', new Uint8Array(4), { scheme: 'rsa-pkcs1' }, { quiet: true }]);
    void api.agree('the-id', new Uint8Array(4), { quiet: true }).catch(() => {});
    expect(requests().at(-1)!.args).toEqual(['the-id', new Uint8Array(4), { quiet: true }]);
    post(hostWindow, { type: 'api-response', id: sent.id, ok: false, error: 'keystore:cancelled' });
    await expect(signing).rejects.toThrow(/^keystore:cancelled$/);

    const decrypting = api.decrypt('the-id', new Uint8Array(256), { scheme: 'rsa-pkcs1' });
    post(hostWindow, { type: 'api-response', id: requests().at(-1)!.id, ok: true, result: new Uint8Array([1, 2]) });
    await expect(decrypting).resolves.toEqual(new Uint8Array([1, 2]));
  }, 30_000);
});
