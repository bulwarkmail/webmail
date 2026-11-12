import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settings-store';

// The shared accounts' sidebar order is keyed per login, because JMAP
// accountIds are only unique on one server.
describe('settings-store sharedMailAccountOrder', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sharedMailAccountOrder: { 'a@h': ['g2', 'g1'] } });
  });

  it('is synced', () => {
    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.sharedMailAccountOrder).toEqual({ 'a@h': ['g2', 'g1'] });
  });

  it('a server load only takes that login\'s entry', () => {
    useSettingsStore.getState().importSettings(
      JSON.stringify({ sharedMailAccountOrder: { 'a@h': ['stale'], 'b@h': ['g3', 'g4'] } }),
      { serverAccountId: 'b@h' },
    );
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({ 'a@h': ['g2', 'g1'], 'b@h': ['g3', 'g4'] });
  });

  it('ignores a value that is not a per-login record', () => {
    useSettingsStore.getState().importSettings(JSON.stringify({ sharedMailAccountOrder: ['g3'] }));
    expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({ 'a@h': ['g2', 'g1'] });
  });

  it('coerces a stored non-record to an empty map when the page loads', async () => {
    const version = useSettingsStore.persist.getOptions().version;
    localStorage.setItem('settings-storage', JSON.stringify({ state: { sharedMailAccountOrder: ['g1'] }, version }));
    try {
      await useSettingsStore.persist.rehydrate();
      expect(useSettingsStore.getState().sharedMailAccountOrder).toEqual({});
    } finally {
      localStorage.removeItem('settings-storage');
    }
  });
});
