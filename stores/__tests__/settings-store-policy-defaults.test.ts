import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));

import { useSettingsStore } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

function setPolicyDefaults(defaults: Record<string, unknown>) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults }, loaded: true });
}

describe('admin policy defaults', () => {
  beforeEach(() => {
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ signaturePosition: 'below_quote', sendConfirmation: false, explicitSettings: [] });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults: {} }, loaded: false });
  });

  it('applies the operator default when the policy loads', () => {
    setPolicyDefaults({ signaturePosition: 'above_quote' });
    expect(useSettingsStore.getState().signaturePosition).toBe('above_quote');
  });

  it('leaves a setting the user chose themselves alone', () => {
    useSettingsStore.getState().updateSetting('signaturePosition', 'below_quote');
    expect(useSettingsStore.getState().explicitSettings).toContain('signaturePosition');

    setPolicyDefaults({ signaturePosition: 'above_quote' });
    expect(useSettingsStore.getState().signaturePosition).toBe('below_quote');
  });

  it('ignores keys that are not settings', () => {
    setPolicyDefaults({ updateSetting: 'x', notASetting: true, explicitSettings: ['signaturePosition'] });
    const state = useSettingsStore.getState();
    expect(typeof state.updateSetting).toBe('function');
    expect(state.explicitSettings).toEqual([]);
    expect('notASetting' in state).toBe(false);
  });

  it('re-applies over a server blob that predates the default', () => {
    setPolicyDefaults({ signaturePosition: 'above_quote' });
    // Blob synced by a client before the operator set the default: it carries
    // the build default and no explicit-settings list.
    useSettingsStore.getState().importSettings(JSON.stringify({ signaturePosition: 'below_quote' }));
    expect(useSettingsStore.getState().signaturePosition).toBe('above_quote');
  });

  it('honours an explicit choice carried in an imported blob', () => {
    setPolicyDefaults({ signaturePosition: 'above_quote' });
    useSettingsStore.getState().importSettings(JSON.stringify({
      signaturePosition: 'below_quote',
      explicitSettings: ['signaturePosition'],
    }));
    expect(useSettingsStore.getState().signaturePosition).toBe('below_quote');
  });

  it('reset to defaults lands on the operator default, not the build default', () => {
    setPolicyDefaults({ signaturePosition: 'above_quote' });
    useSettingsStore.getState().updateSetting('signaturePosition', 'below_quote');
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().signaturePosition).toBe('above_quote');
    expect(useSettingsStore.getState().explicitSettings).toEqual([]);
  });

  it('exports the explicit-settings list so it syncs with the rest', () => {
    useSettingsStore.getState().updateSetting('sendConfirmation', true);
    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.explicitSettings).toEqual(['sendConfirmation']);
  });
});
