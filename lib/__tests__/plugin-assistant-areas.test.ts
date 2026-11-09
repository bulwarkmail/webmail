import { describe, expect, it, vi } from 'vitest';

// The AI assistant's host APIs live in one set of files per area
// (lib/plugin-sandbox/assistant). These tests check that whatever an area
// adds reaches the permission table, the dispatcher, api.host.features and
// the plugin's api, without the shared files naming it.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const area = vi.hoisted(() => ({
  calls: [] as unknown[][],
}));

vi.mock('@/lib/plugin-sandbox/assistant/b', () => ({
  PERMS: { 'email.probeArea': 'email:read' },
  dispatch: async (_plugin: unknown, method: string, args: unknown[]) => { area.calls.push([method, ...args]); return 'from area b'; },
  features: () => ({ probeArea: true }),
}));

vi.mock('@/lib/plugin-sandbox/assistant/b.runtime', () => ({
  runtime: (callApi: (m: string, a: unknown[]) => Promise<unknown>) => ({ email: { probeArea: (x: string) => callApi('email.probeArea', [x]) } }),
}));

const { PERM_PER_METHOD, dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
const { snapshotHostFeatures } = await import('@/lib/plugin-sandbox/host-features');
const { withAssistantRuntime } = await import('@/lib/plugin-sandbox/assistant/runtime');
const { NOT_MINE, dispatchAssistant } = await import('@/lib/plugin-sandbox/assistant');

const plugin = { id: 'p', name: 'P', permissions: ['email:read'], managed: true } as never;

describe('the assistant areas', () => {
  it('put their methods behind their permissions and run them', async () => {
    expect(PERM_PER_METHOD['email.probeArea']).toBe('email:read');
    expect(await dispatchApiCall(plugin, 'email.probeArea', ['x'])).toBe('from area b');
    expect(area.calls).toEqual([['email.probeArea', 'x']]);
    // Without the permission the area never sees the call.
    const without = { ...(plugin as object), permissions: [] } as never;
    await expect(dispatchApiCall(without, 'email.probeArea', [])).rejects.toThrow(/lacks permission "email:read"/);
    expect(area.calls).toHaveLength(1);
  });

  it('leave other methods alone', async () => {
    expect(await dispatchAssistant(plugin, 'email.get', [])).toBe(NOT_MINE);
  });

  it('add their flags to api.host.features', () => {
    expect(snapshotHostFeatures()).toMatchObject({ probeArea: true, externalSenderLabel: false });
  });

  it('add their methods to the plugin api next to the existing ones', () => {
    const calls: unknown[][] = [];
    const api = withAssistantRuntime({ email: { get: () => 'core' } }, async (method, args) => { calls.push([method, args]); return null; });
    expect(api.email.get()).toBe('core');
    (api.email as unknown as { probeArea: (x: string) => unknown }).probeArea('y');
    expect(calls).toEqual([['email.probeArea', ['y']]]);
  });
});
