import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
import { useSettingsStore } from '../settings-store';
import { useThemeStore } from '../theme-store';
const settings = () => useSettingsStore.getState();

beforeEach(() => {
  settings().disableSync();
  useSettingsStore.setState({ displayAccountId: null, displayProfiles: {}, sharedDisplaySourceId: null, accountThemes: {} });
  settings().resetToDefaults();
});

describe('shared display preferences', () => {
  it('restores each account after disabling sharing, including after switching accounts', () => {
    settings().activateDisplayAccount('main');
    settings().updateSetting('density', 'compact');
    settings().activateDisplayAccount('alt');
    settings().updateSetting('density', 'comfortable');
    settings().shareDisplayFrom('main');
    expect(settings().density).toBe('compact');
    settings().activateDisplayAccount('main');
    settings().activateDisplayAccount('alt');
    expect(settings().density).toBe('compact');
    settings().shareDisplayFrom(null);
    expect(settings().density).toBe('comfortable');
  });
  it('never exports the inherited values as the secondary account’s own settings', () => {
    settings().activateDisplayAccount('main');
    settings().updateSetting('fontSize', 'large');
    settings().activateDisplayAccount('alt');
    settings().updateSetting('fontSize', 'small');
    settings().shareDisplayFrom('main');
    expect(settings().fontSize).toBe('large');
    expect(JSON.parse(settings().exportSettings()).fontSize).toBe('small');
  });
  it('accepts server settings for the secondary account without overwriting the overlay', () => {
    settings().activateDisplayAccount('main');
    settings().updateSetting('density', 'compact');
    settings().activateDisplayAccount('alt');
    settings().shareDisplayFrom('main');
    settings().importSettings(JSON.stringify({ density: 'comfortable', trustedSenders: ['alt@example.com'] }), { serverAccountId: 'alt' });
    expect(settings().density).toBe('compact');
    expect(settings().trustedSenders).toEqual(['alt@example.com']);
    settings().shareDisplayFrom(null);
    expect(settings().density).toBe('comfortable');
  });
  it('keeps shared edits made from a secondary account on the next source server load', () => {
    settings().activateDisplayAccount('main');
    settings().shareDisplayFrom('main');
    settings().activateDisplayAccount('alt');
    settings().updateSetting('density', 'extra-compact');
    settings().activateDisplayAccount('main');
    settings().importSettings(JSON.stringify({ density: 'regular' }), { serverAccountId: 'main' });
    expect(settings().density).toBe('extra-compact');
  });
  it('rejects a late server response for an account that is no longer active', () => {
    settings().activateDisplayAccount('alt');
    expect(settings().importSettings(JSON.stringify({ density: 'compact' }), { serverAccountId: 'main' })).toBe(false);
    expect(settings().density).toBe('regular');
  });
  it('restores the shared profile and originals after local storage rehydration', async () => {
    settings().activateDisplayAccount('main');
    settings().updateSetting('density', 'compact');
    settings().activateDisplayAccount('alt');
    settings().updateSetting('density', 'comfortable');
    settings().shareDisplayFrom('main');
    const persisted = localStorage.getItem('settings-storage')!;
    useSettingsStore.setState({ displayProfiles: {}, sharedDisplaySourceId: null });
    localStorage.setItem('settings-storage', persisted);
    await useSettingsStore.persist.rehydrate();
    expect(settings().density).toBe('compact');
    settings().shareDisplayFrom(null);
    expect(settings().density).toBe('comfortable');
  });
  it('keeps theme choices separate and does not carry a custom theme into a new account', () => {
    settings().activateDisplayAccount('main');
    useThemeStore.getState().setTheme('dark');
    settings().activateDisplayAccount('alt');
    useThemeStore.getState().setTheme('light');
    settings().activateDisplayAccount('main');
    expect(useThemeStore.getState().theme).toBe('dark');
    settings().activateDisplayAccount('alt');
    expect(useThemeStore.getState().theme).toBe('light');
  });
  it('reset also updates the profile that will be exported', () => {
    settings().activateDisplayAccount('main');
    settings().updateSetting('density', 'compact');
    settings().resetToDefaults();
    expect(JSON.parse(settings().exportSettings()).density).toBe('regular');
  });
});
