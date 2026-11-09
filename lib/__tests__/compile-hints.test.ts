import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, collect } from '../../scripts/sourcemaps.mjs';
import { COMPILE_HINTS_COMMENT, CompileHintsPlugin, hintPageScripts, pageScriptPaths } from '../../scripts/compile-hints.mjs';
import config from '../../next.config';

// The client build's step that marks the scripts a page starts with for
// Chrome to compile while they download. Run against a stand-in compilation:
// which files get the comment, where in the file, and at which stage.

const OPTIMIZE_SIZE = 400;

class ConcatSource {
  parts: unknown[];
  constructor(...parts: unknown[]) { this.parts = parts; }
  toString(): string { return this.parts.map(String).join(''); }
}

function build(chunks: { initial: boolean; files: string[] }[]) {
  const assets = new Map<string, unknown>();
  for (const chunk of chunks) for (const file of chunk.files) assets.set(file, `/* ${file} */`);
  let stage = -1;
  let run: () => void = () => {};
  const compilation = {
    chunks: chunks.map((c) => ({ canBeInitial: () => c.initial, files: new Set(c.files) })),
    hooks: { processAssets: { tap: (options: { stage: number }, fn: () => void) => { stage = options.stage; run = fn; } } },
    updateAsset: (file: string, update: (source: unknown) => unknown) => { assets.set(file, update(assets.get(file))); },
  };
  const compiler = { hooks: { thisCompilation: { tap: (_name: string, fn: (c: typeof compilation) => void) => fn(compilation) } } };
  new CompileHintsPlugin({ Compilation: { PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: OPTIMIZE_SIZE }, sources: { ConcatSource } }).apply(compiler);
  run();
  return { stage, text: (file: string) => String(assets.get(file)) };
}

describe('compile hints in the client build', () => {
  it('puts the comment on the first line of every script a page starts with', () => {
    const out = build([
      { initial: true, files: ['static/chunks/webpack-1.js', 'static/chunks/app/layout-2.js'] },
      { initial: true, files: ['static/chunks/3794-3.js'] },
    ]);
    expect(COMPILE_HINTS_COMMENT).toBe('//# allFunctionsCalledOnLoad\n');
    for (const file of ['static/chunks/webpack-1.js', 'static/chunks/app/layout-2.js', 'static/chunks/3794-3.js']) {
      expect(out.text(file)).toBe(`//# allFunctionsCalledOnLoad\n/* ${file} */`);
    }
  });

  it('leaves the code split off for later, and anything but scripts, as it is', () => {
    const out = build([
      { initial: false, files: ['static/chunks/5326.viewer.js'] },
      { initial: true, files: ['static/css/app.css', 'static/chunks/x.js.map'] },
    ]);
    expect(out.text('static/chunks/5326.viewer.js')).toBe('/* static/chunks/5326.viewer.js */');
    expect(out.text('static/css/app.css')).toBe('/* static/css/app.css */');
    expect(out.text('static/chunks/x.js.map')).toBe('/* static/chunks/x.js.map */');
  });

  it('is added to the production client build only', () => {
    const webpack = {
      NormalModuleReplacementPlugin: class {},
      Compilation: { PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: OPTIMIZE_SIZE },
      sources: { ConcatSource },
    };
    const plugins = (isServer: boolean, dev: boolean) => {
      const out = config.webpack!({ context: process.cwd(), plugins: [], resolve: { alias: {} }, module: { rules: [] } } as never, { webpack, isServer, dev, dir: process.cwd(), nextRuntime: isServer ? 'nodejs' : undefined } as never) as { plugins: unknown[] };
      return out.plugins.filter((p) => p instanceof CompileHintsPlugin).length;
    };
    expect(plugins(false, false)).toBe(1);
    expect(plugins(true, false)).toBe(0);
    expect(plugins(false, true)).toBe(0);
  });

  it('is still the first line of a chunk after the image build injects debug IDs and moves the maps out', () => {
    // An initial chunk as `sentry-cli sourcemaps inject` (3.8.2) leaves it in a
    // release image (BULWARK_SOURCE_MAPS=1), copied from one built on the rig:
    // the hint stays on line 1, a blank line and the debug-ID snippet follow,
    // and its map gained the two empty lines. Then the Dockerfile's
    // `sourcemaps.mjs collect` moves the map out and drops its comment.
    const root = mkdtempSync(path.join(tmpdir(), 'hints-'));
    try {
      const chunks = path.join(root, 'static', 'chunks');
      mkdirSync(chunks, { recursive: true });
      const file = path.join(chunks, 'webpack-d85ebc21902c97ae.js');
      writeFileSync(file, [
        '//# allFunctionsCalledOnLoad',
        '',
        '!function(){try{var e="undefined"!=typeof window?window:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="da99bed0-bb57-509b-81b3-2c9e6df62ee4")}catch(e){}}();',
        '(()=>{"use strict";var e={};self.webpackChunk_N_E=self.webpackChunk_N_E||[]})();',
        '//# sourceMappingURL=webpack-d85ebc21902c97ae.js.map',
        '//# debugId=da99bed0-bb57-509b-81b3-2c9e6df62ee4',
        '',
      ].join('\n'));
      writeFileSync(`${file}.map`, JSON.stringify({ version: 3, sources: ['webpack/bootstrap'], names: [], mappings: ';;;AAAA' }));

      collect([path.join(root, 'static')], path.join(root, 'maps'));

      const shipped = readFileSync(file, 'utf8');
      expect(shipped.split('\n')[0]).toBe('//# allFunctionsCalledOnLoad');
      expect(shipped).not.toContain('sourceMappingURL');
      expect(check(path.join(root, 'static'))).toEqual([]);
      // The uploaded copy keeps the lines its map counts: code on the fourth.
      const uploaded = readFileSync(path.join(root, 'maps', '0', 'chunks', 'webpack-d85ebc21902c97ae.js'), 'utf8');
      expect(uploaded.split('\n')[3]).toMatch(/^\(\(\)=>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs after the minifier, which would drop the comment, and before source maps and hashes', () => {
    const { stage } = build([]);
    expect(stage).toBeGreaterThan(OPTIMIZE_SIZE);
    // webpack's PROCESS_ASSETS_STAGE_DEV_TOOLING
    expect(stage).toBeLessThan(500);
  });
});

// Lite builds with Turbopack, which has no hook for the plugin: its static
// export gets the comment after the build, on what the exported pages load.
describe('hintPageScripts (Lite)', () => {
  it('reads the scripts a page starts with, not the polyfills or other hosts', () => {
    const html = '<script src="/webmail/_next/static/chunks/a%5Bb%5D.js" async=""></script>'
      + '<script src="/_next/static/chunks/polyfills.js" noModule=""></script>'
      + '<script src="https://cdn.example.com/x.js"></script><script>inline()</script>';
    expect(pageScriptPaths(html)).toEqual(['_next/static/chunks/a[b].js']);
  });

  it('marks each script once, on its first line, and moves its map down a line', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lite-hints-'));
    try {
      const chunks = path.join(root, '_next', 'static', 'chunks');
      mkdirSync(chunks, { recursive: true });
      mkdirSync(path.join(root, 'en', 'mail'), { recursive: true });
      writeFileSync(path.join(chunks, 'start.js'), 'start();');
      writeFileSync(path.join(chunks, 'start.js.map'), JSON.stringify({ version: 3, mappings: 'AAAA' }));
      writeFileSync(path.join(chunks, 'indexed.js'), 'indexed();');
      writeFileSync(path.join(chunks, 'indexed.js.map'), JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: {} }] }));
      writeFileSync(path.join(chunks, 'later.js'), 'later();');
      const page = '<script src="/_next/static/chunks/start.js"></script><script src="/_next/static/chunks/indexed.js"></script>';
      writeFileSync(path.join(root, 'en', 'mail', 'index.html'), page);
      writeFileSync(path.join(root, 'index.html'), page);

      expect(hintPageScripts(root).sort()).toEqual(['_next/static/chunks/indexed.js', '_next/static/chunks/start.js']);
      expect(readFileSync(path.join(chunks, 'start.js'), 'utf8')).toBe(`${COMPILE_HINTS_COMMENT}start();`);
      expect(JSON.parse(readFileSync(path.join(chunks, 'start.js.map'), 'utf8')).mappings).toBe(';AAAA');
      expect(JSON.parse(readFileSync(path.join(chunks, 'indexed.js.map'), 'utf8')).sections[0].offset.line).toBe(1);
      // Code no page starts with compiles as it runs.
      expect(readFileSync(path.join(chunks, 'later.js'), 'utf8')).toBe('later();');
      // A second run changes nothing.
      expect(hintPageScripts(root)).toEqual([]);
      expect(readFileSync(path.join(chunks, 'start.js'), 'utf8')).toBe(`${COMPILE_HINTS_COMMENT}start();`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
