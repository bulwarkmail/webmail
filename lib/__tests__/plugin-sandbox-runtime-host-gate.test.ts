// The document under test is the privileged one on a plugin host over HTTPS,
// as frame-origin.ts places it.
// @vitest-environment-options {"url":"https://plugins.mail.example.org/plugin-sandbox-privileged"}
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
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
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
/** Long enough for a signature check (WebCrypto) before the bundle runs. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

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

  it('forwards composer reads and the conditional edit revision through RPC', async () => {
    framed = true;
    await mountRuntime();
    const message = initMessage();
    message.payload.code = 'module.exports = { activate: async (api) => { const draft = await api.composer.getSnapshot("composer"); await api.composer.readAttachment("composer", "attachment"); await api.composer.replaceBody("composer", { text: "Edited" }, { expectedRevision: draft.revision }); } };';
    post(hostWindow, HOST_ORIGIN, message);
    await flush();
    const requests = () => hostWindow.postMessage.mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'api-request');
    expect(requests()[0]).toMatchObject({ method: 'composer.getSnapshot', args: ['composer'] });
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: requests()[0].id, ok: true, result: { revision: 'revision-one' } });
    await flush();
    expect(requests()[1]).toMatchObject({ method: 'composer.readAttachment', args: ['composer', 'attachment'] });
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: requests()[1].id, ok: true, result: { data: new ArrayBuffer(1) } });
    await flush();
    expect(requests()[2]).toMatchObject({ method: 'composer.replaceBody', args: ['composer', { text: 'Edited' }, { expectedRevision: 'revision-one' }] });
    post(hostWindow, HOST_ORIGIN, { type: 'api-response', id: requests()[2].id, ok: true, result: true });
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

// PLUGIN_FRAME_SUBDOMAIN (frame-origin.ts): on the plugin origin the host page
// is not served from this document's origin. The server names the webmail's
// origin in the document it writes, and that is the only host.
describe('plugin sandbox runtime on the plugin origin', () => {
  const WEBMAIL_ORIGIN = 'https://mail.example.org';
  const PREFIX = 'bulwark-privileged-frame-bundle-v1\n';
  const server = generateKeyPairSync('ed25519');
  const rawKey = (key: KeyObject) => Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url').toString('base64');
  const sign = (text: string, key: KeyObject = server.privateKey) => nodeSign(null, Buffer.from(text), key).toString('base64');

  /** The key the server writes into the document. */
  function nameKey(content: string = rawKey(server.publicKey)): void {
    const meta = document.createElement('meta');
    meta.name = 'bulwark-bundle-key';
    meta.content = content;
    document.head.appendChild(meta);
  }

  /** The init message with the signature the page carries. */
  function signedInit(codeSignature?: string) {
    const msg = initMessage();
    return { ...msg, payload: { ...msg.payload, ...(codeSignature === undefined ? {} : { codeSignature }) } };
  }

  const initErrors = () => hostWindow.postMessage.mock.calls
    .map(([msg]) => msg as { type: string; error?: string })
    .filter((msg) => msg.type === 'init-error')
    .map((msg) => msg.error);

  function nameHost(content: string): void {
    const meta = document.createElement('meta');
    meta.name = 'bulwark-host-origin';
    meta.content = content;
    document.head.appendChild(meta);
  }

  afterEach(() => {
    document.head.querySelectorAll('meta[name="bulwark-host-origin"], meta[name="bulwark-bundle-key"]').forEach((meta) => meta.remove());
  });

  it('takes the webmail the document names as its host', async () => {
    nameHost(WEBMAIL_ORIGIN);
    nameKey();
    framed = true;
    await mountRuntime();

    expect(postedTypes()).toEqual([['sandbox-ready', WEBMAIL_ORIGIN]]);
    post(hostWindow, WEBMAIL_ORIGIN, signedInit(sign(PREFIX + BUNDLE)));
    await settle();
    expect(marker.__sandboxBundleRan).toBe(HOST_ORIGIN);
    expect(initErrors()).toEqual([]);
  });

  // Behind a TLS proxy that sends no X-Forwarded-Proto the server takes the
  // webmail for plain HTTP and names it so. The webmail shares this frame's
  // scheme, which the browser knows.
  it('takes the scheme of the webmail from its own location, not from the server', async () => {
    expect(window.location.protocol).toBe('https:');
    nameHost('http://mail.example.org');
    nameKey();
    framed = true;
    await mountRuntime();

    expect(postedTypes()).toEqual([['sandbox-ready', WEBMAIL_ORIGIN]]);
    post(hostWindow, WEBMAIL_ORIGIN, signedInit(sign(PREFIX + BUNDLE)));
    await settle();
    expect(marker.__sandboxBundleRan).toBe(HOST_ORIGIN);
  });

  // The page that frames it is what the plugin origin is kept apart from: a
  // script there must not get code of its own to run on this origin.
  it.each([
    ['no signature', () => undefined],
    ['an empty signature', () => ''],
    ['the signature of the install, which any admin-installed bundle has', () => sign(BUNDLE)],
    ['the signature of another bundle', () => sign(PREFIX + 'module.exports = {};')],
    ['a signature by another key', () => sign(PREFIX + BUNDLE, generateKeyPairSync('ed25519').privateKey)],
    ['a signature that is not base64', () => '***'],
  ])('does not run a bundle that comes with %s', async (_name, signature) => {
    nameHost(WEBMAIL_ORIGIN);
    nameKey();
    framed = true;
    await mountRuntime();

    post(hostWindow, WEBMAIL_ORIGIN, signedInit(signature()));
    await settle();

    expect(marker.__sandboxBundleRan).toBeUndefined();
    expect(initErrors()).toHaveLength(1);
  });

  it('runs nothing when the document carries no key', async () => {
    nameHost(WEBMAIL_ORIGIN);
    framed = true;
    await mountRuntime();

    post(hostWindow, WEBMAIL_ORIGIN, signedInit(sign(PREFIX + BUNDLE)));
    await settle();

    expect(marker.__sandboxBundleRan).toBeUndefined();
    expect(initErrors()).toHaveLength(1);
  });

  it('does not take a key the page hands over with the bundle', async () => {
    const attacker = generateKeyPairSync('ed25519');
    nameHost(WEBMAIL_ORIGIN);
    nameKey();
    framed = true;
    await mountRuntime();

    const msg = signedInit(sign(PREFIX + BUNDLE, attacker.privateKey));
    post(hostWindow, WEBMAIL_ORIGIN, { ...msg, payload: { ...msg.payload, bundleKey: rawKey(attacker.publicKey), key: rawKey(attacker.publicKey) } });
    await settle();

    expect(marker.__sandboxBundleRan).toBeUndefined();
  });

  // The frame's own origin is the plugin origin: a page there is not the host.
  it.each([HOST_ORIGIN, ATTACKER_ORIGIN, 'null'])('ignores its parent posting from %s', async (origin) => {
    nameHost(WEBMAIL_ORIGIN);
    framed = true;
    await mountRuntime();

    post(hostWindow, origin, initMessage());
    await flush();

    expect(marker.__sandboxBundleRan).toBeUndefined();
  });

  it.each(['null', 'javascript:alert(1)', 'https://mail.example.org/path', 'not an origin', ''])(
    'falls back to its own origin for a name that is not an origin (%j)', async (content) => {
      nameHost(content);
      framed = true;
      await mountRuntime();

      expect(postedTypes()).toEqual([['sandbox-ready', HOST_ORIGIN]]);
    },
  );
});
