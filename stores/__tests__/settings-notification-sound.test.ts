import { beforeEach, describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings } from '../settings-store';

// The new mail sound defaults to Involved; 'default' is the beep, which was
// the default before.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

describe('notification sound default', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('plays Involved on a fresh install', () => {
    expect(useSettingsStore.getState().notificationSoundChoice).toBe('involved');
  });

  it('moves a beep the user never picked to Involved', () => {
    expect(migrate({ notificationSoundChoice: 'default', explicitSettings: [] }, 9).notificationSoundChoice).toBe('involved');
  });

  it('keeps a beep the user picked', () => {
    const out = migrate({ notificationSoundChoice: 'default', explicitSettings: ['notificationSoundChoice'] }, 9);
    expect(out.notificationSoundChoice).toBe('default');
  });

  it('keeps any other sound the user picked', () => {
    expect(migrate({ notificationSoundChoice: 'relax', explicitSettings: [] }, 9).notificationSoundChoice).toBe('relax');
  });

  it('does not take the beep from before explicitSettings existed as chosen', () => {
    const out = migrate({ notificationSoundChoice: 'default' }, 7);
    expect(out.notificationSoundChoice).toBe('involved');
    expect(out.explicitSettings).not.toContain('notificationSoundChoice');
  });

  it('moves the beep along in a server copy or export from an older build', () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ notificationSoundChoice: 'default', explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().notificationSoundChoice).toBe('involved');

    expect(store.importSettings(JSON.stringify({ notificationSoundChoice: 'default' }))).toBe(true);
    expect(useSettingsStore.getState().notificationSoundChoice).toBe('involved');
    expect(useSettingsStore.getState().explicitSettings).not.toContain('notificationSoundChoice');

    expect(store.importSettings(JSON.stringify({ notificationSoundChoice: 'default', explicitSettings: ['notificationSoundChoice'] }))).toBe(true);
    expect(useSettingsStore.getState().notificationSoundChoice).toBe('default');
  });
});
