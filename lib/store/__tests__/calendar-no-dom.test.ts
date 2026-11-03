// @vitest-environment node
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

async function inputsOf(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    alias: { '@': root },
    metafile: true,
    logLevel: 'silent',
    // Stay away from the packages' own graph: only our files matter here.
    packages: 'external',
  });
  return Object.keys(result.metafile.inputs);
}

describe('what the worker pulls in', () => {
  for (const entry of ['lib/store/calendar/index.ts', 'lib/store/calendar/reminders.ts']) {
    it(`${entry} reaches no UI code`, async () => {
      const inputs = await inputsOf(entry);
      expect(inputs.length).toBeGreaterThan(3);
      expect(inputs.filter((file) => /(^|\/)(components|stores|hooks|app)\//.test(file))).toEqual([]);
    }, 30_000);
  }
});
