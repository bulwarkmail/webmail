import { describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { snapshotHostFeatures } = await import('../plugin-sandbox/host-features');

// A plugin sees answerInvitation and changeSettings only once it was granted
// the optional permission behind them: one enabled before the update that
// added them doesn't have it until the user turns it off and on.

function plugin(granted: string[]): InstalledPlugin {
  return {
    id: 'ai-assistant', name: 'AI', version: '2.2.0', author: 'test', description: '', type: 'hook',
    permissions: ['calendar:respond', 'settings:change'], grantedPermissions: granted,
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  } as InstalledPlugin;
}

describe('the area c flags for one plugin', () => {
  it('follow what the plugin was granted', () => {
    expect(snapshotHostFeatures(plugin([]))).toMatchObject({ answerInvitation: false, changeSettings: false, batchMail: true });
    expect(snapshotHostFeatures(plugin(['calendar:respond']))).toMatchObject({ answerInvitation: true, changeSettings: false });
    expect(snapshotHostFeatures(plugin(['calendar:respond', 'settings:change']))).toMatchObject({ answerInvitation: true, changeSettings: true });
  });

  it('say what the webmail offers when no plugin is named', () => {
    expect(snapshotHostFeatures()).toMatchObject({ answerInvitation: true, changeSettings: true });
  });
});
