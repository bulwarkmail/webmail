import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSendGuards,
  downSendGuards,
  getSendGuardSource,
  guardsSending,
  rememberDeclaredHooks,
  setSendGuardSource,
} from '@/lib/plugin-send-guards';
import { runPluginSendCheck } from '@/lib/outgoing/plugin-send-check';
import { emailHooks } from '@/lib/plugin-hooks';
import type { InstalledPlugin, OutgoingEmail } from '@/lib/plugin-types';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

// A send check the admin force-enabled that is starting, failed to start or
// was turned off after errors used to let every message through.

const guard = (patch: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'send-checks', name: 'Send checks', version: '1.0.0', author: '', description: '', type: 'hook',
  permissions: ['email:send', 'email:read'], entrypoint: 'index.js', enabled: true, status: 'running',
  settings: {}, managed: true, forceEnabled: true, bundleHash: 'abc', ...patch,
});

const email: OutgoingEmail = { to: ['x@example.org'], cc: [], bcc: [], subject: 's', htmlBody: '', textBody: 't', identityId: 'i', attachments: [] };

beforeEach(() => {
  localStorage.clear();
  // Plugins are on (the default policy has them off).
  const state = usePolicyStore.getState();
  usePolicyStore.setState({ policy: { ...state.policy, features: { ...state.policy.features, pluginsEnabled: true } } });
});
afterEach(() => {
  usePluginStore.setState({ plugins: [], initialized: false, serverPluginsSynced: false });
  emailHooks.onBeforeEmailSend.clear();
  vi.useRealTimers();
});

describe('downSendGuards', () => {
  it('counts a required guard that is starting, failed to start or was turned off after errors', () => {
    usePluginStore.setState({
      plugins: [
        guard({ id: 'a', status: 'enabled' }),
        guard({ id: 'b', status: 'error', error: 'Bundle integrity mismatch: expected x, got y' }),
        guard({ id: 'c', status: 'error', error: 'auto-disabled', enabled: false }),
        guard({ id: 'd', status: 'running' }),
      ],
    });
    expect(downSendGuards().map((g) => [g.id, g.state])).toEqual([['a', 'loading'], ['b', 'failed'], ['c', 'failed']]);
  });

  it("doesn't count a plugin Bulwark refused on purpose, nor one the user turned on", () => {
    usePluginStore.setState({
      plugins: [
        guard({ id: 'a', status: 'error', error: 'third-party-off' }),
        guard({ id: 'b', status: 'error', error: 'approval-denied' }),
        guard({ id: 'c', status: 'error', error: 'Privileged tier requires the "crypto:full" permission' }),
        guard({ id: 'd', status: 'enabled', forceEnabled: false, managed: false }),
      ],
    });
    expect(downSendGuards()).toEqual([]);
  });

  it('counts a plugin the policy forces on', () => {
    const spy = vi.spyOn(usePolicyStore.getState(), 'isPluginForceEnabled').mockImplementation((id: string) => id === 'p');
    usePluginStore.setState({ plugins: [guard({ id: 'p', forceEnabled: false, status: 'enabled' })] });
    expect(downSendGuards().map((g) => g.id)).toEqual(['p']);
    spy.mockRestore();
  });

  it('knows a guard by the hooks of its last start, else by the email:send permission', () => {
    expect(guardsSending(guard())).toBe(true);
    expect(guardsSending(guard({ permissions: ['email:read'] }))).toBe(false);
    rememberDeclaredHooks(guard(), 'abc', ['onComposeSend']);
    expect(guardsSending(guard())).toBe(false);
    // Another bundle: what the old one did no longer says anything.
    expect(guardsSending(guard({ bundleHash: '"DEF"' }))).toBe(true);
    rememberDeclaredHooks(guard({ bundleHash: 'def' }), 'def', ['onBeforeEmailSend']);
    expect(guardsSending(guard({ bundleHash: '"DEF"' }))).toBe(true);
  });
});

describe('awaitSendGuards', () => {
  it('waits for a guard that is starting and goes on once it runs', async () => {
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const waiting = awaitSendGuards(5000);
    usePluginStore.setState({ plugins: [guard({ status: 'running' })] });
    expect(await waiting).toEqual([]);
  });

  it('gives up after the wait and reports it down', async () => {
    vi.useFakeTimers();
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const waiting = awaitSendGuards(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toEqual([{ id: 'send-checks', name: 'Send checks', state: 'loading' }]);
  });

  it('sees nothing without a source (no plugin store, as in Lite)', async () => {
    const storeSource = getSendGuardSource();
    setSendGuardSource(null);
    try {
      usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'auto-disabled' })] });
      expect(await awaitSendGuards(10)).toEqual([]);
    } finally {
      setSendGuardSource(storeSource);
    }
  });
});

describe('runPluginSendCheck', () => {
  it('holds the send while a required guard is down, without asking the others', async () => {
    const handler = vi.fn(() => undefined);
    emailHooks.onBeforeEmailSend.register('other', handler);
    usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'auto-disabled', enabled: false })] });
    expect(await runPluginSendCheck(() => email)).toBe('guard-failed');
    expect(handler).not.toHaveBeenCalled();
    usePluginStore.setState({ plugins: [guard()] });
    expect(await runPluginSendCheck(() => email)).toBe('allowed');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// A plugin the admin forces on that hasn't reached this browser (a new
// device, a failed plugin sync) used to count for nothing: mail went out
// unchecked until it arrived.
describe('a forced plugin this browser has not got yet', () => {
  const forceInPolicy = (ids: string[]) => {
    const state = usePolicyStore.getState();
    usePolicyStore.setState({ policy: { ...state.policy, forceEnabledPlugins: ids } });
  };
  afterEach(() => forceInPolicy([]));

  it('counts as starting until the admin list arrived in full, then not', () => {
    forceInPolicy(['send-checks']);
    usePluginStore.setState({ plugins: [], initialized: true, serverPluginsSynced: false });
    expect(downSendGuards()).toEqual([{ id: 'send-checks', name: 'send-checks', state: 'loading' }]);
    usePluginStore.setState({ initialized: false, serverPluginsSynced: true });
    expect(downSendGuards().map((g) => g.id)).toEqual(['send-checks']);
    // The server left it out on purpose (refused in the no-third-party mode, removed).
    usePluginStore.setState({ initialized: true, serverPluginsSynced: true });
    expect(downSendGuards()).toEqual([]);
  });

  it('counts nothing while the admin turned plugins off', () => {
    forceInPolicy(['send-checks']);
    const state = usePolicyStore.getState();
    usePolicyStore.setState({ policy: { ...state.policy, features: { ...state.policy.features, pluginsEnabled: false } } });
    try {
      usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'auto-disabled' })], initialized: false });
      expect(downSendGuards()).toEqual([]);
    } finally {
      usePolicyStore.setState({ policy: { ...state.policy } });
    }
  });
});

// A send right after sign-in, while the check was still starting, gave it a
// message built for nobody: no external recipients, no file types.
describe('runPluginSendCheck builds the message after the wait', () => {
  it('asks a check that finished starting with the message built then', async () => {
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const seen: unknown[] = [];
    let built = 0;
    const pending = runPluginSendCheck(() => { built++; return { ...email, externalRecipients: ['x@outside.test'] }; });
    expect(built).toBe(0);
    emailHooks.onBeforeEmailSend.register('send-checks', (m: OutgoingEmail) => { seen.push(m); return false; });
    usePluginStore.setState({ plugins: [guard({ status: 'running' })] });
    expect(await pending).toBe('vetoed');
    expect(built).toBe(1);
    expect(seen).toEqual([expect.objectContaining({ externalRecipients: ['x@outside.test'] })]);
  });

  it('says whether a guard is starting or has stopped working', async () => {
    vi.useFakeTimers();
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const waiting = runPluginSendCheck(() => email);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await waiting).toBe('guard-loading');
    vi.useRealTimers();
    usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'Bundle integrity mismatch' })] });
    expect(await runPluginSendCheck(() => email)).toBe('guard-failed');
  });
});
