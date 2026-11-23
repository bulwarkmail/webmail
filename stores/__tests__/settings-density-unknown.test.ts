import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settings-store';
import { DEFAULT_DENSITY, densityVarsFor, type Density } from '@/lib/density';

// A density this build doesn't know comes from a newer build (server sync,
// an export) or stays behind in the browser after a downgrade. It must not
// reach the page: the spacing tables, the row-height guess and the settings
// sample all look the value up and break on a miss.
describe('a density this build does not know', () => {
  beforeEach(() => {
    useSettingsStore.setState({ density: 'compact' });
  });

  it('is ignored by an import or a server load', () => {
    useSettingsStore.getState().importSettings(JSON.stringify({ density: 'future-density' }));
    expect(useSettingsStore.getState().density).toBe('compact');
    useSettingsStore.getState().importSettings(JSON.stringify({ density: 'future-density' }), { serverAccountId: 'a@h' });
    expect(useSettingsStore.getState().density).toBe('compact');
  });

  it('is put back to regular when the page loads', async () => {
    const version = useSettingsStore.persist.getOptions().version;
    localStorage.setItem('settings-storage', JSON.stringify({ state: { density: 'future-density' }, version }));
    try {
      await useSettingsStore.persist.rehydrate();
      expect(useSettingsStore.getState().density).toBe('regular');
    } finally {
      localStorage.removeItem('settings-storage');
    }
  });

  it('gets the regular spacing', () => {
    expect(densityVarsFor('future-density' as Density, 'default')).toEqual(DEFAULT_DENSITY.regular);
  });
});
