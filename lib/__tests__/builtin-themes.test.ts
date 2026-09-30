import { describe, it, expect } from 'vitest';
import { BUILTIN_THEMES } from '../builtin-themes';

describe('BUILTIN_THEMES', () => {
  it('contains exactly 7 themes', () => {
    expect(BUILTIN_THEMES).toHaveLength(7);
  });

  it('all themes have required fields', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.id).toBeTruthy();
      expect(theme.name).toBeTruthy();
      expect(theme.version).toBeTruthy();
      expect(theme.author).toBe('Built-in');
      expect(theme.css).toBeTruthy();
      expect(theme.variants).toEqual(['light', 'dark']);
      expect(theme.enabled).toBe(true);
      expect(theme.builtIn).toBe(true);
    }
  });

  it('all IDs are prefixed with builtin-', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.id).toMatch(/^builtin-/);
    }
  });

  it('all themes have both :root and .dark selectors', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.css).toContain(':root');
      expect(theme.css).toContain('.dark');
    }
  });

  it('all themes set --color-primary', () => {
    for (const theme of BUILTIN_THEMES) {
      expect(theme.css).toContain('--color-primary:');
    }
  });

  it('themes have correct names', () => {
    const names = BUILTIN_THEMES.map(t => t.name);
    expect(names).toContain('Flat fields');
    expect(names).toContain('Nord');
    expect(names).toContain('Catppuccin');
    expect(names).toContain('Solarized');
    expect(names).toContain('Roundcube Elastic');
    expect(names).toContain('Aurora Glass');
  });

  it('theme IDs are unique', () => {
    const ids = BUILTIN_THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
