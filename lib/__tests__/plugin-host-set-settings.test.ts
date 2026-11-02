import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useLocaleStore } from '@/stores/locale-store';
import { settingsHooks } from '../plugin-hooks';
import { clearUndoTokens } from '../plugin-sandbox/assistant/c.undo';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(id: string, perms: string[]): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const ASSISTANT = plugin('assistant', ['settings:read', 'settings:change']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);
type Change = { applied: Record<string, { old: unknown; new: unknown }>; refused: Record<string, string>; undoToken: string | null };

const policy = usePolicyStore.getState().policy;
function restrict(restrictions: Record<string, unknown>, features: Record<string, boolean> = {}) {
  usePolicyStore.setState({ policy: { ...policy, restrictions: { ...policy.restrictions, ...restrictions }, features: { ...policy.features, ...features } } } as never);
}

beforeEach(() => {
  clearUndoTokens();
  useAuthStore.setState({ client: { getAccountId: () => 'acc1' } as unknown as IJMAPClient });
  useLocaleStore.setState({ locale: 'en' });
  useSettingsStore.setState({ timeFormat: '24h', deleteAction: 'trash', showPreview: true } as never);
  usePolicyStore.setState({ policy } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null });
  usePolicyStore.setState({ policy } as never);
});

describe('api.app.describeSettings', () => {
  it('says what a change would do in the user\'s words', async () => {
    const out = await call(ASSISTANT, 'app.describeSettings', { timeFormat: '12h' }) as Record<string, Record<string, unknown>>;
    expect(out.timeFormat).toMatchObject({
      label: 'Time format', page: 'general', current: '24h', next: '12h', allowed: true,
    });
    expect(out.timeFormat.currentLabel).toMatch(/24/);
    expect(out.timeFormat.nextLabel).toMatch(/12/);
    expect(out.timeFormat.options).toHaveLength(2);
  });
});

describe('api.app.setSettings', () => {
  it('changes a setting through the store, reads it back and puts it back on undo', async () => {
    const result = await call(ASSISTANT, 'app.setSettings', { timeFormat: '12h' }) as Change;
    expect(result.applied).toEqual({ timeFormat: { old: '24h', new: '12h' } });
    expect(useSettingsStore.getState().timeFormat).toBe('12h');
    // The settings page counts it as the user's own choice.
    expect(useSettingsStore.getState().explicitSettings).toContain('timeFormat');

    const undone = await call(ASSISTANT, 'app.undoSettings', result.undoToken) as { restored: string[] };
    expect(undone.restored).toEqual(['timeFormat']);
    expect(useSettingsStore.getState().timeFormat).toBe('24h');
  });

  it('refuses what is not on the allow-list, values it rules out, and unknown keys', async () => {
    const result = await call(ASSISTANT, 'app.setSettings', {
      externalContentPolicy: 'allow', deleteAction: 'permanent', readReceiptResponse: 'always', confirmBulkDelete: false, fooBar: 1,
    }) as Change;
    expect(result.refused).toEqual({
      externalContentPolicy: 'not_allowed', deleteAction: 'bad_value', readReceiptResponse: 'bad_value', confirmBulkDelete: 'bad_value', fooBar: 'unknown',
    });
    expect(result.undoToken).toBeNull();
    expect(useSettingsStore.getState().deleteAction).toBe('trash');
  });

  it('refuses settings the admin locked or hid, rows a gate hides, and values outside a restriction', async () => {
    restrict({ timeFormat: { locked: true }, showPreview: { hidden: true }, markAsReadDelay: { allowedValues: [0] } }, { unifiedCrossAccountEnabled: false });
    const result = await call(ASSISTANT, 'app.setSettings', {
      timeFormat: '12h', showPreview: false, unifiedCrossAccount: true, markAsReadDelay: 3000,
    }) as Change;
    expect(result.refused).toEqual({ timeFormat: 'locked', showPreview: 'hidden', unifiedCrossAccount: 'unavailable', markAsReadDelay: 'bad_value' });
    expect(useSettingsStore.getState().timeFormat).toBe('24h');
  });

  it('says so when another plugin stops the change', async () => {
    const off = settingsHooks.onBeforeSettingChange.register('guard', (async () => false) as never);
    try {
      const result = await call(ASSISTANT, 'app.setSettings', { timeFormat: '12h' }) as Change;
      expect(result.refused).toEqual({ timeFormat: 'stopped' });
      expect(useSettingsStore.getState().timeFormat).toBe('24h');
    } finally {
      off.dispose();
    }
  }, 10_000);

  it('undo writes the exact old value, but not where the admin has locked it since', async () => {
    useSettingsStore.setState({ deleteAction: 'permanent' } as never);
    const result = await call(ASSISTANT, 'app.setSettings', { deleteAction: 'trash', timeFormat: '12h' }) as Change;
    restrict({ timeFormat: { locked: true } });
    const undone = await call(ASSISTANT, 'app.undoSettings', result.undoToken) as { restored: string[]; refused: Record<string, string> };
    expect(undone).toEqual({ restored: ['deleteAction'], refused: { timeFormat: 'locked' } });
    // A value the assistant may not set, put back because the user had it.
    expect(useSettingsStore.getState().deleteAction).toBe('permanent');
  });

  it('needs settings:change, and keeps the undo to its plugin', async () => {
    await expect(call(plugin('reader', ['settings:read']), 'app.setSettings', { timeFormat: '12h' })).rejects.toThrow(/lacks permission "settings:change"/);
    const result = await call(ASSISTANT, 'app.setSettings', { timeFormat: '12h' }) as Change;
    await expect(call(plugin('other', ['settings:change']), 'app.undoSettings', result.undoToken)).rejects.toThrow(/can't be undone/);
    expect(useSettingsStore.getState().timeFormat).toBe('12h');
  });
});
