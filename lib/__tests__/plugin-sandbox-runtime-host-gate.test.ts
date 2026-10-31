/**
 * The plugin sandbox runtime hands `init.code` to `new Function` under an
 * 'unsafe-eval' CSP. It used to pin "the host" to whichever window posted to
 * it first, so any website could window.open() /plugin-sandbox, post its own
 * `init` before a real host existed, and run code in the webmail origin with
 * the victim's session (GHSA-96cx-gx36-3g79). The host is now fixed from
 * browser-owned facts before the listener exists: the framing window
 * (`window.parent`) posting from this document's own URL origin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

const HOST_ORIGIN = window.location.origin;
const ATTACKER_ORIGIN = 'https://attacker.example';

// The bundle leaves a marker behind so the test can tell whether it ran.
const BUNDLE = 'globalThis.__sandboxBundleRan = location.origin; module.exports = {};';
const marker = globalThis as { __sandboxBundleRan?: string };

function initMessage() {
  return {
    type: 'init',
    payload: {
      mode: 'background',
      pluginId: 'x',
      tier: 'privileged',
      locale: 'en',
      manifest: { id: 'x', version: '1.0.0', permissions: [], settings: {} },
      code: BUNDLE,
    },
  };
}

/** Dispatch a message event the way the browser would for `source`. */
function post(source: unknown, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin });
  // jsdom only accepts real Window objects in the constructor's `source`;
  // override the prototype getter on the instance instead.
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
let framed = false;
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

beforeEach(() => {
  // The runtime keeps its host binding and boot flag at module scope.
  vi.resetModules();
  delete marker.__sandboxBundleRan;
  hostWindow = { postMessage: vi.fn() };
  framed = false;
  Object.defineProperty(window, 'parent', {
    configurable: true,
    get: () => (framed ? (hostWindow as unknown as Window) : window),
  });
});

afterEach(() => {
  cleanup();
  if (realParent) Object.defineProperty(window, 'parent', realParent);
});

async function mountRuntime(): Promise<void> {
  const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
  render(React.createElement(SandboxRuntime));
}

function postedTypes(): Array<[string, string]> {
  return hostWindow.postMessage.mock.calls.map(([msg, target]) => [(msg as { type: string }).type, target as string]);
}

describe('plugin sandbox runtime host gate (GHSA-96cx-gx36-3g79)', () => {
  it('stays inert when loaded as a top-level document, whoever posts to it', async () => {
    framed = false;
    await mountRuntime();

    // The window.open() attack: the opener posts init before any host could.
    const opener = { postMessage: vi.fn() };
    post(opener, ATTACKER_ORIGIN, initMessage());
    // Even a same-origin sender gets nothing - there is no framing host.
    post(hostWindow, HOST_ORIGIN, initMessage());
    await flush();

    expect(marker.__sandboxBundleRan).toBeUndefined();
    expect(opener.postMessage).not.toHaveBeenCalled();
    expect(hostWindow.postMessage).not.toHaveBeenCalled();
  });

  it('pings only the framing window, targeted at its own origin', async () => {
    framed = true;
    await mountRuntime();

    expect(postedTypes()).toEqual([['sandbox-ready', HOST_ORIGIN]]);
  });

  it('ignores a sender that is not the framing window, and is not poisoned by it', async () => {
    framed = true;
    await mountRuntime();

    const other = { postMessage: vi.fn() };
    post(other, HOST_ORIGIN, initMessage());
    await flush();
    expect(marker.__sandboxBundleRan).toBeUndefined();
    expect(other.postMessage).not.toHaveBeenCalled();

    // The real host still boots afterwards: the rejected message did not
    // consume the one-shot init.
    post(hostWindow, HOST_ORIGIN, initMessage());
    await flush();
    expect(marker.__sandboxBundleRan).toBe(HOST_ORIGIN);
  });

  it('ignores the framing window when it posts from another origin', async () => {
    framed = true;
    await mountRuntime();

    post(hostWindow, ATTACKER_ORIGIN, initMessage());
    await flush();
    expect(marker.__sandboxBundleRan).toBeUndefined();
    expect(postedTypes()).toEqual([['sandbox-ready', HOST_ORIGIN]]);

    post(hostWindow, HOST_ORIGIN, initMessage());
    await flush();
    expect(marker.__sandboxBundleRan).toBe(HOST_ORIGIN);
  });

  it('returns the progress handle through RPC and awaits its explicit dismissal', async () => {
    framed = true;
    await mountRuntime();
    const message = initMessage();
    message.payload.code = 'module.exports = { activate: async (api) => { const id = await api.toast.progress("Working"); await api.toast.dismiss(id); } };';
    post(hostWindow, HOST_ORIGIN, message);
    await flush();
    const request = hostWindow.postMessage.mock.calls.map(([msg]) => msg).find((msg) => msg.method === 'toast.progress');
    expect(request).toMatchObject({ type: 'api-request', args: ['Working'] });
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: request.id, ok: true, result: 'owned-toast' });
    await flush();
    const dismiss = hostWindow.postMessage.mock.calls.map(([msg]) => msg).find((msg) => msg.method === 'toast.dismiss');
    expect(dismiss).toMatchObject({ type: 'api-request', args: ['owned-toast'] });
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: dismiss.id, ok: true });
    await flush();
    expect(postedTypes().some(([type]) => type === 'init-done')).toBe(true);
  });

  it('boots the bundle for the framing window on its own origin and reports back to it', async () => {
    framed = true;
    await mountRuntime();

    post(hostWindow, HOST_ORIGIN, initMessage());
    await flush();

    expect(marker.__sandboxBundleRan).toBe(HOST_ORIGIN);
    expect(postedTypes()).toEqual([
      ['sandbox-ready', HOST_ORIGIN],
      ['init-done', HOST_ORIGIN],
    ]);
  });
});
