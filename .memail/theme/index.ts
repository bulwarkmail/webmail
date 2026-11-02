import manifest from './manifest.json';
import skin from './skin.mjs';
import { compileAdvancedTheme } from '../../lib/theme-compiler';
import type { InstalledTheme, ThemeManifest } from '../../lib/plugin-types';

// One manifest and skin drive both delivery paths; no generated CSS to drift.
const theme = manifest as ThemeManifest;
const compiled = compileAdvancedTheme(theme);
if (compiled.errors.length) throw new Error(compiled.errors.join('; '));
export const memailTheme: InstalledTheme = {
  ...theme,
  css: compiled.css,
  skin,
  enabled: true,
  builtIn: true,
};
