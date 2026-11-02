import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, '.memail/plugins/focus-inbox');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
const compiled = await build({entryPoints:[resolve(directory,'index.ts')],bundle:true,format:'cjs',platform:'neutral',target:'es2022',write:false});
const code = compiled.outputFiles[0].text;
// Package validation against the host is covered by focus-plugin.test.ts.
const zip = new JSZip();
const date = new Date('2026-01-01T00:00:00Z');
zip.file('manifest.json', JSON.stringify(manifest,null,2), {date});
zip.file('index.js', code, {date});
const output = resolve(root, 'out/memail-focus-inbox.zip');
await mkdir(dirname(output), {recursive:true});
await writeFile(output, await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log(output);
if (process.argv.includes('--dev')) {
  const dev = resolve(root, 'local-data/memail-plugins/focus-inbox');
  await mkdir(dev, {recursive:true});
  await writeFile(resolve(dev,'manifest.json'), JSON.stringify(manifest,null,2));
  await writeFile(resolve(dev,'index.js'),code);
  console.log(`Development plugin: ${dev}`);
}
