import { afterEach, expect, it, vi } from 'vitest';
import { pluginStorage } from '@/lib/plugin-storage';
import { useThemeStore } from '../theme-store';

afterEach(() => {
  vi.restoreAllMocks();
  useThemeStore.setState(useThemeStore.getInitialState());
});

it('does not restore a previous account theme when its CSS finishes loading late', async () => {
  const base = useThemeStore.getState().installedThemes[0];
  useThemeStore.setState({ installedThemes: [
    { ...base, id: 'slow-account-theme', css: '' },
    { ...base, id: 'current-account-theme', css: ':root { --color-primary: #dc2626; }' },
  ], activeThemeId: null });
  let finishLoad!: (css: string) => void;
  vi.spyOn(pluginStorage, 'getThemeCSS').mockImplementation(() => new Promise<string>(resolve => { finishLoad = resolve; }));
  useThemeStore.getState().activateTheme('slow-account-theme');
  useThemeStore.getState().activateTheme('current-account-theme');
  finishLoad(':root { --color-primary: #2563eb; }');
  await Promise.resolve();
  expect(useThemeStore.getState().activeThemeId).toBe('current-account-theme');
});
