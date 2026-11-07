// Chrome's explicit compile hint for the scripts a page needs to start.
//
// V8 compiles a function the first time it runs, on the page's main thread. A
// cold start runs the code of every module on the first screen once, so most
// of what the browser did between downloading the scripts and drawing the
// sign-in form or the first rows was compiling: about half a second on the
// benchmark rig. With `//# allFunctionsCalledOnLoad` at the top of a script,
// Chrome (136 and later) compiles all of it while it downloads, on another
// thread. Other browsers read a comment.
//
// Only the chunks a page loads at its start get it (webpack's initial chunks).
// The code split off for later, the reader and the editor among it, is
// compiled as it runs, so nothing is compiled ahead that may never run.
//
// Webpack builds (the Docker image, the desktop app): next.config.ts adds the
// plugin to the client build. Turbopack has no such hook, so Lite's static
// export gets the comment afterwards (hintPageScripts, from
// scripts/lite/postbuild.mjs): on every script an exported page names.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The comment, on a line of its own. */
export const COMPILE_HINTS_COMMENT = '//# allFunctionsCalledOnLoad\n';

/** The local scripts a page's HTML loads at its start (not the nomodule polyfills). */
export function pageScriptPaths(html) {
  const out = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (/\bnomodule\b/i.test(tag)) continue;
    const src = /\bsrc="([^"]+\.js)"/i.exec(tag)?.[1];
    if (!src || /^[a-z]+:|^\/\//i.test(src)) continue;
    const at = src.indexOf('/_next/');
    if (at !== -1) out.push(decodeURIComponent(src.slice(at + 1).split('?')[0]));
  }
  return out;
}

function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '_next') htmlFiles(p, out);
    } else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * Puts the comment on the first line of every script an exported page under
 * `outDir` starts with, once. A source map next to a script gets an empty
 * first line, so it still points at the right lines. Returns the scripts it
 * marked.
 */
export function hintPageScripts(outDir) {
  const scripts = new Set();
  for (const file of htmlFiles(outDir)) for (const s of pageScriptPaths(readFileSync(file, 'utf8'))) scripts.add(s);
  const marked = [];
  for (const rel of scripts) {
    const path = join(outDir, rel);
    if (!existsSync(path)) continue;
    const code = readFileSync(path, 'utf8');
    if (code.startsWith(COMPILE_HINTS_COMMENT)) continue;
    writeFileSync(path, COMPILE_HINTS_COMMENT + code);
    const map = `${path}.map`;
    if (existsSync(map)) {
      const parsed = JSON.parse(readFileSync(map, 'utf8'));
      if (typeof parsed.mappings === 'string') {
        parsed.mappings = `;${parsed.mappings}`;
        writeFileSync(map, JSON.stringify(parsed));
      } else if (Array.isArray(parsed.sections)) {
        // An index map (Turbopack writes these): every section moves down a line.
        for (const section of parsed.sections) if (section?.offset) section.offset.line += 1;
        writeFileSync(map, JSON.stringify(parsed));
      }
    }
    marked.push(rel);
  }
  return marked;
}

export class CompileHintsPlugin {
  /** @param {{ Compilation: { PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: number }, sources: { ConcatSource: new (...parts: unknown[]) => unknown } }} webpack */
  constructor(webpack) {
    this.webpack = webpack;
  }

  /** @param {any} compiler */
  apply(compiler) {
    const { Compilation, sources } = this.webpack;
    compiler.hooks.thisCompilation.tap('CompileHintsPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        // After minifying, which would drop the comment, and before the
        // source maps and the content hashes, which then account for the line.
        { name: 'CompileHintsPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1 },
        () => {
          for (const chunk of compilation.chunks) {
            if (!chunk.canBeInitial()) continue;
            for (const file of chunk.files) {
              if (!file.endsWith('.js')) continue;
              compilation.updateAsset(file, (source) => new sources.ConcatSource(COMPILE_HINTS_COMMENT, source));
            }
          }
        },
      );
    });
  }
}
