#!/usr/bin/env node
// Writes the desktop app's policy templates to desktop-policies/, from
// lib/desktop/policy-schema.ts: ADMX, ADML (en, de), a sample .mobileconfig and a
// sample policies.json. lib/desktop/__tests__/policy-templates.test.ts fails when
// what's committed differs from this.
//
//   node scripts/generate-desktop-policies.mjs
//   node scripts/generate-desktop-policies.mjs --shell <repos/desktop checkout>
//
// --shell also copies the schema to the desktop repo's src/shared/policy-schema.ts.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'desktop-policies');

const temp = mkdtempSync(path.join(tmpdir(), 'bulwark-policies-'));
const bundle = path.join(temp, 'templates.mjs');
await build({
  entryPoints: [path.join(ROOT, 'lib/desktop/policy-templates.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning',
});
const { generatePolicyFiles } = await import(pathToFileURL(bundle).href);
rmSync(temp, { recursive: true, force: true });

for (const [name, content] of Object.entries(generatePolicyFiles())) {
  const file = path.join(OUT, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(path.relative(ROOT, file));
}

const shellIndex = process.argv.indexOf('--shell');
if (shellIndex !== -1) {
  const target = path.join(process.argv[shellIndex + 1], 'src', 'shared', 'policy-schema.ts');
  copyFileSync(path.join(ROOT, 'lib/desktop/policy-schema.ts'), target);
  console.log(target);
}
