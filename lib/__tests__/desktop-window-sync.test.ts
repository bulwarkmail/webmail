import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopBootScript } from '@/lib/desktop/boot';
import { startWindowSync } from '@/lib/desktop/window-sync';
import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';

/** What another window of this browser writing the store looks like here. */
function writeFromAnotherWindow(key: string, state: Record<string, unknown>) {
  const current = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":0}');
  const value = JSON.stringify({ ...current, state: { ...current.state, ...state } });
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('state across windows', () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    useThemeStore.setState({ theme: 'light' });
    useLocaleStore.setState({ locale: 'en' });
  });

  afterEach(() => {
    stop();
    stop = () => {};
    delete window.bulwarkDesktop;
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'light');
  });

  function asPopout() {
    window.history.replaceState(null, '', '/en/popout/compose');
    stop = startWindowSync();
  }

  it('follows a theme change without a reload, down to the page', async () => {
    asPopout();
    writeFromAnotherWindow('theme-storage', { theme: 'dark' });
    await settle();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows a theme pack change too, which rehydrating alone does not put on the page', async () => {
    asPopout();
    const pack = useThemeStore.getState().installedThemes.find((theme) => theme.css);
    expect(pack).toBeTruthy();
    writeFromAnotherWindow('theme-storage', { theme: 'light', activeThemeId: pack!.id });
    await settle();
    expect(document.querySelector('style[id*="theme"]')?.textContent).toContain(pack!.css);
  });

  it('follows a language change without a reload', async () => {
    asPopout();
    writeFromAnotherWindow('locale-storage', { locale: 'de' });
    await settle();
    expect(useLocaleStore.getState().locale).toBe('de');
  });

  it('follows a settings change without a reload', async () => {
    asPopout();
    const before = useSettingsStore.getState().plainTextMode;
    writeFromAnotherWindow('settings-storage', { plainTextMode: !before });
    await settle();
    expect(useSettingsStore.getState().plainTextMode).toBe(!before);
  });

  it('also runs in the desktop app\'s main window', async () => {
    window.bulwarkDesktop = { windows: {} };
    stop = startWindowSync();
    writeFromAnotherWindow('locale-storage', { locale: 'fr' });
    await settle();
    expect(useLocaleStore.getState().locale).toBe('fr');
  });

  it('leaves a browser tab as it was', async () => {
    stop = startWindowSync();
    writeFromAnotherWindow('locale-storage', { locale: 'fr' });
    await settle();
    expect(useLocaleStore.getState().locale).toBe('en');
  });
});

describe('the app-like behaviour', () => {
  const css = readFileSync(join(process.cwd(), 'app/desktop.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^}]*\}/g) ?? [];

  it('hangs entirely on html[data-desktop], so browsers do not change', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf('{'));
      // Every selector of the list; commas inside :is() don't split it.
      const parts = selector.split(/,(?![^(]*\))/);
      for (const part of parts) expect(part.trim(), part).toMatch(/^html\[data-desktop\]/);
    }
  });

  it('covers UI chrome and what the spec names', () => {
    expect(css).toMatch(/user-select: none/);
    expect(css).toMatch(/cursor: default/);
    expect(css).toMatch(/overscroll-behavior: none/);
    expect(css).toMatch(/-webkit-user-drag: none/);
  });

  it('keeps fields selectable and what the app drags draggable', () => {
    expect(css).toMatch(/:is\(input, textarea, select, \[contenteditable="true"\][^{]*\{\s*-webkit-user-select: text;\s*user-select: text;/);
    expect(css).toMatch(/\[draggable="true"\]\s*\{\s*-webkit-user-drag: element;/);
  });

  it('does not switch selection off for the whole page, so message content stays selectable', () => {
    expect(css).not.toMatch(/html\[data-desktop\]( body)?\s*\{[^}]*user-select: none/);
  });

  function runBoot() {
    new Function(desktopBootScript())();
  }

  afterEach(() => {
    delete window.bulwarkDesktop;
    document.documentElement.removeAttribute('data-desktop');
  });

  it('marks the page before the first paint when the bridge is there', () => {
    window.bulwarkDesktop = {};
    runBoot();
    expect(document.documentElement.hasAttribute('data-desktop')).toBe(true);
  });

  it('does not mark a browser', () => {
    runBoot();
    expect(document.documentElement.hasAttribute('data-desktop')).toBe(false);
  });

  it('is in the root layout\'s boot script', () => {
    const layout = readFileSync(join(process.cwd(), 'app/(main)/layout.tsx'), 'utf8');
    expect(layout).toContain('${desktopBootScript()}');
    expect(layout).toContain('../desktop.css');
  });
});
