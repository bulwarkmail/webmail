import { beforeEach, describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings, undoSendOptions } from '../settings-store';

// Undo send is on by default with 5 seconds; it was off (0) before. Off that
// the user never picked moves to 5, Off they picked stays.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

describe('undo send default', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('gives 5 seconds to undo on a fresh install', () => {
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(5);
  });

  it('turns on undo send for someone who never chose Off', () => {
    expect(migrate({ sendDelaySeconds: 0, explicitSettings: [] }, 12).sendDelaySeconds).toBe(5);
  });

  it('keeps Off that the user chose', () => {
    const out = migrate({ sendDelaySeconds: 0, explicitSettings: ['sendDelaySeconds'] }, 12);
    expect(out.sendDelaySeconds).toBe(0);
  });

  it('keeps a delay the user chose, 60 seconds included', () => {
    expect(migrate({ sendDelaySeconds: 30, explicitSettings: ['sendDelaySeconds'] }, 12).sendDelaySeconds).toBe(30);
    expect(migrate({ sendDelaySeconds: 60 }, 7).sendDelaySeconds).toBe(60);
  });

  it('does not take Off from before explicitSettings existed as chosen', () => {
    const out = migrate({ sendDelaySeconds: 0 }, 7);
    expect(out.sendDelaySeconds).toBe(5);
    expect(out.explicitSettings).not.toContain('sendDelaySeconds');
  });

  it('turns undo send on in a server copy or export from an older build', () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ sendDelaySeconds: 0, explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(5);

    expect(store.importSettings(JSON.stringify({ sendDelaySeconds: 0, explicitSettings: ['sendDelaySeconds'] }))).toBe(true);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(0);
  });

  it('keeps Off once the user picks it', () => {
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 0);
    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as Record<string, unknown>;
    expect(migrate(exported, 13).sendDelaySeconds).toBe(0);
  });

  it('offers Off, 5, 10 and 30 seconds, and 60 only to someone who has it', () => {
    expect(undoSendOptions(5)).toEqual([0, 5, 10, 30]);
    expect(undoSendOptions(60)).toEqual([0, 5, 10, 30, 60]);
  });
});
