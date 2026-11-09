import { beforeEach, describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings } from '../settings-store';

// List rows are plain by default; tinting them by the first tag color was
// the default before.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

describe('tint list rows by tag default', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('keeps rows plain on a fresh install', () => {
    expect(useSettingsStore.getState().tintListRowsByTag).toBe(false);
  });

  it('turns off a tint the user never switched on', () => {
    expect(migrate({ tintListRowsByTag: true, explicitSettings: [] }, 10).tintListRowsByTag).toBe(false);
  });

  it('keeps a tint the user switched on', () => {
    const out = migrate({ tintListRowsByTag: true, explicitSettings: ['tintListRowsByTag'] }, 10);
    expect(out.tintListRowsByTag).toBe(true);
  });

  it('does not take the tint from before explicitSettings existed as chosen', () => {
    const out = migrate({ tintListRowsByTag: true }, 7);
    expect(out.tintListRowsByTag).toBe(false);
    expect(out.explicitSettings).not.toContain('tintListRowsByTag');
  });

  it('turns the tint off in a server copy or export from an older build', () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ tintListRowsByTag: true, explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().tintListRowsByTag).toBe(false);

    expect(store.importSettings(JSON.stringify({ tintListRowsByTag: true }))).toBe(true);
    expect(useSettingsStore.getState().tintListRowsByTag).toBe(false);
    expect(useSettingsStore.getState().explicitSettings).not.toContain('tintListRowsByTag');

    expect(store.importSettings(JSON.stringify({ tintListRowsByTag: true, explicitSettings: ['tintListRowsByTag'] }))).toBe(true);
    expect(useSettingsStore.getState().tintListRowsByTag).toBe(true);
  });
});
