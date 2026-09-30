#!/usr/bin/env node
// Stages a finished static export for the container image (Dockerfile.lite):
//
//   <dest>/html/                   out/ without the static-host helpers
//   <dest>/default.conf.template   nginx config, filled in at container start
//
//   node scripts/lite/container.mjs [dest]   # default: <repo>/lite-image
//
// The image only COPYs from <dest>, so its final stage runs no command and a
// multi-arch build needs no emulation.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTAINER_EXCLUDED_FILES, buildNginxContainerTemplate, isMainModule, resolveRepoRoot } from "./lib.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

export function stageContainer({ root = repoRoot, dest = join(root, "lite-image"), log = console.log } = {}) {
  const outDir = join(root, "out");
  let build;
  try {
    build = JSON.parse(readFileSync(join(outDir, "lite-build.json"), "utf8"));
  } catch {
    throw new Error(`[lite] ${join(outDir, "lite-build.json")} is missing - run \`npm run build:lite\` first`);
  }
  if (build.target !== "static") throw new Error(`[lite] the container image serves the static target, out/ holds the ${build.target} target`);
  // The nginx config is root-relative; a sub-path belongs to the reverse proxy's host, not the image.
  if (build.basePath) throw new Error(`[lite] the container image serves from /, out/ was built with NEXT_PUBLIC_BASE_PATH=${build.basePath}`);

  const htmlDir = join(dest, "html");
  rmSync(htmlDir, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(outDir, htmlDir, { recursive: true });
  for (const name of CONTAINER_EXCLUDED_FILES) rmSync(join(htmlDir, name), { force: true });
  writeFileSync(join(dest, "default.conf.template"), buildNginxContainerTemplate());
  log(`[lite] staged the container image content in ${dest}`);
  return { dest, htmlDir };
}

if (isMainModule(import.meta.url)) {
  try {
    const arg = process.argv[2];
    stageContainer(arg ? { dest: resolve(arg) } : {});
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
