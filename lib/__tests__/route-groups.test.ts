// @vitest-environment node
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_GROUPS, PAGE_AREAS } from '@/lib/route-groups';

const ROOT = path.resolve(__dirname, '..', '..');
const dirs = (rel: string) => readdirSync(path.join(ROOT, rel)).filter((name) => statSync(path.join(ROOT, rel, name)).isDirectory());

// The groups are a fixed list so metric labels and report routes stay
// bounded; a new API folder or page area has to be added to it.
describe('route groups', () => {
  it('list every API folder', () => {
    expect([...API_GROUPS].sort()).toEqual(dirs('app/api').filter((d) => d !== '__tests__').sort());
  });

  it('list every page area', () => {
    const areas = dirs('app/(main)/[locale]').filter((d) => !d.startsWith('[') && !d.startsWith('('));
    for (const area of areas) expect(PAGE_AREAS).toContain(area);
  });
});
