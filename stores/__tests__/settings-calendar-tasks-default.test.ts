import { beforeEach, describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings, migrateCalendarTasksDefault } from '../settings-store';

// pim-8: tasks were off by default and hard to find. They are on where the
// server has calendars; a user who switched them off keeps them off.

const migrate = (state: Record<string, unknown>, version: number) =>
  migrateSettings(state, version) as unknown as Record<string, unknown>;

describe('tasks on by default (pim-8)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('shows tasks on a fresh install', () => {
    expect(useSettingsStore.getState().enableCalendarTasks).toBe(true);
  });

  it('turns on tasks that were only off by the old default', () => {
    const state: Record<string, unknown> = { enableCalendarTasks: false, explicitSettings: [] };
    migrateCalendarTasksDefault(state);
    expect(state.enableCalendarTasks).toBe(true);
  });

  it('keeps tasks off for a user who switched them off', () => {
    const state: Record<string, unknown> = { enableCalendarTasks: false, explicitSettings: ['enableCalendarTasks'] };
    migrateCalendarTasksDefault(state);
    expect(state.enableCalendarTasks).toBe(false);
  });

  it('does not take the old default from before explicitSettings existed as chosen', () => {
    const out = migrate({ enableCalendarTasks: false }, 7);
    expect(out.enableCalendarTasks).toBe(true);
    expect(out.explicitSettings).not.toContain('enableCalendarTasks');
  });

  it('turns them on in a server copy or export from an older build, and off stays off when chosen', () => {
    const store = useSettingsStore.getState();
    expect(store.importSettings(JSON.stringify({ enableCalendarTasks: false, explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().enableCalendarTasks).toBe(true);
    expect(store.importSettings(JSON.stringify({ enableCalendarTasks: false, explicitSettings: ['enableCalendarTasks'] }))).toBe(true);
    expect(useSettingsStore.getState().enableCalendarTasks).toBe(false);
  });

  it('remembers switching them off', () => {
    useSettingsStore.getState().updateSetting('enableCalendarTasks', false);
    expect(useSettingsStore.getState().explicitSettings).toContain('enableCalendarTasks');
  });
});
