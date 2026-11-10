import { beforeEach, describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings } from '../settings-store';

// The focus outline is off by default; it was Normal before. Normal that the
// user never picked turns off, Normal they picked stays.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

describe('focus outline default', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('is off on a fresh install', () => {
    expect(useSettingsStore.getState().focusRing).toBe('off');
  });

  it('runs for state stored before the default changed', () => {
    expect(useSettingsStore.persist.getOptions().version).toBeGreaterThanOrEqual(16);
  });

  it('turns the outline off for someone who never chose Normal', () => {
    expect(migrate({ focusRing: 'normal', explicitSettings: [] }, 15).focusRing).toBe('off');
  });

  it('keeps Normal that the user chose', () => {
    expect(migrate({ focusRing: 'normal', explicitSettings: ['focusRing'] }, 15).focusRing).toBe('normal');
  });

  it('keeps a thicker outline, chosen or from a preset', () => {
    expect(migrate({ focusRing: 'thick', explicitSettings: [] }, 15).focusRing).toBe('thick');
    expect(migrate({ focusRing: 'extra', explicitSettings: ['focusRing'] }, 15).focusRing).toBe('extra');
  });

  it('keeps the outline of someone who switched on Always show focus', () => {
    const out = migrate({ focusRing: 'normal', focusAlwaysVisible: true, explicitSettings: ['focusAlwaysVisible'] }, 15);
    expect(out.focusRing).toBe('normal');
  });

  it('does not take Normal from before explicitSettings existed as chosen', () => {
    const out = migrate({ focusRing: 'normal' }, 7);
    expect(out.focusRing).toBe('off');
    expect(out.explicitSettings).not.toContain('focusRing');
  });

  it('turns the outline off in a server copy or export from an older build', () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ focusRing: 'normal', explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().focusRing).toBe('off');

    expect(store.importSettings(JSON.stringify({ focusRing: 'normal', explicitSettings: ['focusRing'] }))).toBe(true);
    expect(useSettingsStore.getState().focusRing).toBe('normal');
  });

  it('keeps Normal once the user picks it', () => {
    useSettingsStore.getState().updateSetting('focusRing', 'normal');
    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as Record<string, unknown>;
    expect(migrate(exported, 15).focusRing).toBe('normal');
  });
});
