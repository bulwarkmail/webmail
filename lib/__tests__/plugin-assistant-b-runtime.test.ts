/**
 * The AI assistant's host-call flags (lib/plugin-sandbox/assistant) reach
 * the plugin: api.host.features in the sandbox carries them from init and
 * follows host-change, next to the core flags.
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

describe('the assistant flags in the sandbox runtime', () => {
  let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
  const g = globalThis as { __pluginApi?: { host: { features: Record<string, boolean> } }; __seenAtActivate?: boolean };

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
    delete g.__seenAtActivate;
    if (realParent) Object.defineProperty(window, 'parent', realParent);
  });

  it('come with init and follow host-change', async () => {
    const bundle = `module.exports = { activate: function (api) {
      globalThis.__seenAtActivate = api.host.features.attachmentText;
      globalThis.__pluginApi = api;
    } };`;
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));
    post(hostWindow, {
      type: 'init',
      payload: {
        mode: 'background', pluginId: 'x', tier: 'privileged', locale: 'en',
        manifest: { id: 'x', version: '1.0.0', permissions: [], settings: {} },
        code: bundle,
        hostFeatures: { externalSenderLabel: false, externalRecipientWarning: false, noThirdPartyTraffic: false, attachmentText: true },
      },
    });
    await waitFor(() => expect(g.__pluginApi).toBeDefined());
    expect(g.__seenAtActivate).toBe(true);
    const kept = g.__pluginApi!.host.features;
    post(hostWindow, { type: 'host-change', features: { externalSenderLabel: true, externalRecipientWarning: false, noThirdPartyTraffic: false, attachmentText: 'yes' } });
    // Booleans only: anything but true is false.
    expect(kept).toMatchObject({ externalSenderLabel: true, attachmentText: false });
  }, 30_000);
});
