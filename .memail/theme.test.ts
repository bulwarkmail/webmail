import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readThemePackage } from '../lib/extension-package';
import { getLuminance, parseColor } from '../lib/color-transform';
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '.memail/theme/manifest.json'), 'utf8'));
function contrast(a: string, b: string) {
  const first = parseColor(a)!; const second = parseColor(b)!;
  const x = getLuminance(first.r, first.g, first.b);
  const y = getLuminance(second.r, second.g, second.b);
  return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);
}
describe('Memail theme', () => {
  it('installs through the upstream package validator without warnings', async () => {
    const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(manifest));
    const result = await readThemePackage(await zip.generateAsync({type:'uint8array'}));
    expect(result.errors).toEqual([]); expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true); expect(result.css).toContain('--color-primary');
  });
  for (const mode of ['light','dark']) {
    it(`${mode}: body and muted text reach 4.5:1 on the app surfaces`, () => {
      const t = manifest.tokens[mode];
      for (const ground of ['background','card','popover','sidebar','secondary','muted']) {
        for (const foreground of ['foreground','muted-foreground']) {
          expect(contrast(t[foreground],t[ground]),`${foreground} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const base of ['primary','secondary','accent','selection','sidebar-accent']) {
        expect(contrast(t[`${base}-foreground`],t[base]),base).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t.ring,t.background)).toBeGreaterThanOrEqual(3);
    });
  }
});
