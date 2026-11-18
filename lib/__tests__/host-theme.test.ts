import { describe, it, expect, afterEach } from 'vitest';
import { snapshotHostTheme, themeSnapshotToCSS, type ThemeSnapshot } from '../plugin-sandbox/host-theme';

describe('host-theme', () => {
  describe('themeSnapshotToCSS', () => {
    it('emits the token values, font, and color-scheme', () => {
      const snapshot: ThemeSnapshot = {
        dark: false,
        fontFamily: 'Inter, sans-serif',
        vars: { '--color-background': '#ffffff', '--color-foreground': '#0f172a' },
      };
      const css = themeSnapshotToCSS(snapshot);
      expect(css).toContain('--color-background: #ffffff;');
      expect(css).toContain('--color-foreground: #0f172a;');
      expect(css).toContain('font-family: Inter, sans-serif;');
      expect(css).toContain('color-scheme: light;');
      // Body inherits the theme foreground so unstyled plugin text adapts.
      expect(css).toContain('color: var(--color-foreground, inherit);');
      expect(css).toContain('background: transparent;');
    });

    it("applies the user's font size so rem units in a slot match the app", () => {
      const css = themeSnapshotToCSS({ dark: false, fontFamily: 'x', vars: { '--font-size-base': '17px' } });
      expect(css).toMatch(/:root \{[^}]*font-size: var\(--font-size-base\);/);
    });

    it('reports a dark color-scheme when dark', () => {
      const css = themeSnapshotToCSS({ dark: true, fontFamily: 'sans-serif', vars: {} });
      expect(css).toContain('color-scheme: dark;');
    });
  });

  describe('snapshotHostTheme', () => {
    afterEach(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('style');
    });

    it('reads the dark flag and declared tokens off <html>', () => {
      document.documentElement.classList.add('dark');
      document.documentElement.style.setProperty('--color-background', '#0a0a0a');
      const snapshot = snapshotHostTheme();
      expect(snapshot.dark).toBe(true);
      expect(snapshot.vars['--color-background']).toBe('#0a0a0a');
      expect(snapshot.fontFamily).toBeTruthy();
    });

    it('passes the list section header colors on to plugins', () => {
      document.documentElement.style.setProperty('--color-list-section', '#1f1f1f');
      document.documentElement.style.setProperty('--color-list-section-foreground', '#e5e5e5');
      const snapshot = snapshotHostTheme();
      expect(snapshot.vars['--color-list-section']).toBe('#1f1f1f');
      expect(snapshot.vars['--color-list-section-foreground']).toBe('#e5e5e5');
    });
  });
});
