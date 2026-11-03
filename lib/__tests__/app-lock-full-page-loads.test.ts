import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// With the app lock on, a full page load in the tab that holds the key loses the key, and
// the user is asked for the PIN again. So the app's own moves use the router. A load that
// has to be one says why on the line before: `// full-load: the reason`.

const ROOTS = ['hooks', 'lib/plugin-sandbox'];
const LOAD = /location\.(assign|reload|replace)\(|location\.href\s*=[^=]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('full page loads', () => {
  it('none without a reason in the paths the app moves around in', () => {
    const unexplained: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (LOAD.test(line) && !/full-load:/.test(lines[index - 1] ?? '')) unexplained.push(`${file}:${index + 1}`);
      });
    }
    expect(unexplained).toEqual([]);
  });
});
