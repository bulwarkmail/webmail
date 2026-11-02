/**
 * api.host.features tells plugins which of Bulwark's own features replace
 * them (externalSenderLabel and externalRecipientWarning: the
 * organisation's External label and recipient warning). The host sends it with init and again on every
 * change; the runtime keeps one object up to date.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { usePolicyStore } from '@/stores/policy-store';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import {
  EXTERNAL_MAIL_WARNING_PLUGIN_ID,
  isHookHandedOver,
  isSlotHandedOver,
  snapshotHostFeatures,
} from '@/lib/plugin-sandbox/host-features';

function setExternalMail(patch: Partial<typeof DEFAULT_ORGANISATION_POLICY.externalMail>) {
  usePolicyStore.setState({
    policy: {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, externalMail: { ...DEFAULT_ORGANISATION_POLICY.externalMail, ...patch } },
    },
  });
}

beforeEach(() => setExternalMail({}));

describe('snapshotHostFeatures', () => {
  it('has one flag per switch', () => {
    expect(snapshotHostFeatures()).toEqual({ externalSenderLabel: false, externalRecipientWarning: false, noThirdPartyTraffic: false });
    setExternalMail({ senderLabel: true });
    expect(snapshotHostFeatures()).toEqual({ externalSenderLabel: true, externalRecipientWarning: false, noThirdPartyTraffic: false });
    setExternalMail({ recipientWarning: true });
    expect(snapshotHostFeatures()).toEqual({ externalSenderLabel: false, externalRecipientWarning: true, noThirdPartyTraffic: false });
  });

  // A link check switches Google Safe Browsing off in the mode instead of
  // taking the refused requests for a service that is down.
  it('says when third-party traffic is off, and while that is not known yet', () => {
    setNoThirdPartyTraffic(true);
    expect(snapshotHostFeatures().noThirdPartyTraffic).toBe(true);
    setNoThirdPartyTraffic('unknown');
    expect(snapshotHostFeatures().noThirdPartyTraffic).toBe(true);
    setNoThirdPartyTraffic(false);
    expect(snapshotHostFeatures().noThirdPartyTraffic).toBe(false);
  });
});

describe('hand-over of the external-mail-warning plugin', () => {
  it('skips its send check with the recipient warning and its toast and banner with the label', () => {
    const id = EXTERNAL_MAIL_WARNING_PLUGIN_ID;
    expect(isHookHandedOver(id, 'onBeforeEmailSend')).toBe(false);
    expect(isSlotHandedOver(id, 'email-banner')).toBe(false);
    setExternalMail({ recipientWarning: true });
    expect(isHookHandedOver(id, 'onBeforeEmailSend')).toBe(true);
    expect(isHookHandedOver(id, 'onNewEmailReceived')).toBe(false);
    expect(isSlotHandedOver(id, 'email-banner')).toBe(false);
    setExternalMail({ senderLabel: true });
    expect(isHookHandedOver(id, 'onBeforeEmailSend')).toBe(false);
    expect(isHookHandedOver(id, 'onNewEmailReceived')).toBe(true);
    expect(isSlotHandedOver(id, 'email-banner')).toBe(true);
    // Its other hooks, and every other plugin, keep running.
    expect(isHookHandedOver(id, 'onIdentitiesLoaded')).toBe(false);
    expect(isHookHandedOver('reply-all-guardrail', 'onBeforeEmailSend')).toBe(false);
    expect(isSlotHandedOver('spam-score', 'email-banner')).toBe(false);
  });
});

// ─── Host bridge: init payload and pushes ────────────────────

describe('host bridge', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('puts the features into the init payload and pushes changes to running frames', async () => {
    const { createBackgroundInstance } = await import('@/lib/plugin-sandbox/host-bridge');
    setExternalMail({ senderLabel: true });
    const plugin = { id: 'p', name: 'P', version: '1.0.0', permissions: [], settings: {}, settingsSchema: {} } as never;
    const instance = createBackgroundInstance({ plugin, tier: 'privileged', code: '', locale: 'en' });
    const pending = (instance as unknown as { pendingInit: { hostFeatures?: unknown } | null }).pendingInit;
    expect(pending?.hostFeatures).toEqual({ externalSenderLabel: true, externalRecipientWarning: false, noThirdPartyTraffic: false });

    // Before init has gone out a change lands in the payload ...
    setExternalMail({});
    expect(pending?.hostFeatures).toEqual({ externalSenderLabel: false, externalRecipientWarning: false, noThirdPartyTraffic: false });

    // ... after it, as a host-change message.
    const sent: unknown[] = [];
    (instance as unknown as { pendingInit: unknown }).pendingInit = null;
    (instance as unknown as { send: (m: unknown) => void }).send = (m) => sent.push(m);
    setExternalMail({ recipientWarning: true });
    expect(sent).toEqual([{ type: 'host-change', features: { externalSenderLabel: false, externalRecipientWarning: true, noThirdPartyTraffic: false } }]);
    // The admin turns third-party traffic off: running plugins hear it.
    setNoThirdPartyTraffic(true);
    expect(sent[1]).toEqual({ type: 'host-change', features: { externalSenderLabel: false, externalRecipientWarning: true, noThirdPartyTraffic: true } });
    setNoThirdPartyTraffic(false);
    instance.destroy();
  }, 30_000);
});

// ─── Sandbox runtime: api.host.features ──────────────────────

const HOST_ORIGIN = window.location.origin;

function post(source: unknown, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

describe('api.host in the sandbox runtime', () => {
  let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
  const g = globalThis as {
    __pluginApi?: { host: { features: { externalSenderLabel: boolean; externalRecipientWarning: boolean }; onFeaturesChange(fn: (f: unknown) => void): () => void } };
    __seenAtActivate?: boolean;
  };

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

  it('has the value from init in activate and follows host-change', async () => {
    const bundle = `module.exports = { activate: function (api) {
      globalThis.__seenAtActivate = api.host.features.externalRecipientWarning;
      globalThis.__pluginApi = api;
    } };`;
    const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
    render(React.createElement(SandboxRuntime));
    post(hostWindow, HOST_ORIGIN, {
      type: 'init',
      payload: {
        mode: 'background', pluginId: 'x', tier: 'privileged', locale: 'en',
        manifest: { id: 'x', version: '1.0.0', permissions: [], settings: {} },
        code: bundle,
        hostFeatures: { externalSenderLabel: false, externalRecipientWarning: true },
      },
    });
    await waitFor(() => expect(g.__pluginApi).toBeDefined());
    expect(g.__seenAtActivate).toBe(true);

    const api = g.__pluginApi!;
    const kept = api.host.features;
    const changes: unknown[] = [];
    api.host.onFeaturesChange((f) => changes.push({ ...(f as object) }));
    post(hostWindow, HOST_ORIGIN, { type: 'host-change', features: { externalSenderLabel: true, externalRecipientWarning: false, noThirdPartyTraffic: true } });
    expect(kept.externalRecipientWarning).toBe(false);
    expect(kept.externalSenderLabel).toBe(true);
    expect((kept as { noThirdPartyTraffic?: boolean }).noThirdPartyTraffic).toBe(true);
    expect(changes).toEqual([{ externalSenderLabel: true, externalRecipientWarning: false, noThirdPartyTraffic: true }]);
  }, 30_000);
});
