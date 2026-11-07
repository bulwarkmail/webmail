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
// Webpack builds only (the Docker image, the desktop app): next.config.ts
// adds the plugin to the client build.

/** The comment, on a line of its own. */
export const COMPILE_HINTS_COMMENT = '//# allFunctionsCalledOnLoad\n';

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
