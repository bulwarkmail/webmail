#!/usr/bin/env node
// `npm run build:lite` - the whole Lite pipeline in one process so no
// cross-platform env juggling is needed:
//
//   1. prepare   delete server-only trees (disposable checkout only)
//   2. next build with NEXT_PUBLIC_BULWARK_LITE=1 (output: "export")
//   3. postbuild write config.json, manifest, host snippets into out/
//              (Stalwart target: the entry document, then the zip)
//   4. verify    fail on missing files or undocumented /api references
//
// With BULWARK_SOURCE_MAPS=1 (CI) the browser source maps move out of out/
// right after the build, before anything is packed, into SOURCEMAPS_OUT
// (default sourcemaps/lite-<target>) for the error tracker. Either way the
// export and the Stalwart zip are checked for maps last.
//
// Inputs (env): LITE_TARGET (static | stalwart), LITE_JMAP_SERVER_URL,
// LITE_APP_NAME, LITE_ALLOW_CUSTOM_ENDPOINT, LITE_REMEMBER_ME, LITE_DEMO_MODE,
// LITE_NO_THIRD_PARTY_TRAFFIC,
// LITE_LOCALES, NEXT_PUBLIC_BASE_PATH (static target only),
// NEXT_PUBLIC_DEFAULT_LOCALE, GIT_COMMIT. Flags: --target=stalwart,
// --skip-prepare (tree already pruned), --dry-run (print the plan only).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBuildId, normalizeBasePath, parseLiteTarget, resolveRepoRoot, STALWART_ZIP_NAME } from "./lib.mjs";
import { runPrepare } from "./prepare.mjs";
import { runPostbuild } from "./postbuild.mjs";
import { verifyExport } from "./verify.mjs";
import { buildPstWorker } from "../build-pst-worker.mjs";
import { check as checkSourceMaps, collect as collectSourceMaps } from "../sourcemaps.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const target = parseLiteTarget(argv, process.env);

if (target === "stalwart" && normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH)) {
  console.error("[lite] --target=stalwart detects its mount prefix at runtime (Stalwart's urlPrefix); unset NEXT_PUBLIC_BASE_PATH");
  process.exit(1);
}

let version = "0.0.0";
try {
  version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
} catch {
  // no VERSION file
}
const commit = (process.env.GIT_COMMIT ?? "").trim().slice(0, 7) || "local";

const env = {
  ...process.env,
  NEXT_PUBLIC_BULWARK_LITE: "1",
  // Without the proxy nothing rewrites /mail to /en/mail: the locale must be
  // in every URL.
  NEXT_PUBLIC_LOCALE_PREFIX: "always",
  NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1",
  LITE_TARGET: target,
  NEXT_PUBLIC_LITE_TARGET: target,
  // One id for the bundle and the entry document that fetches from it.
  NEXT_PUBLIC_LITE_BUILD_ID: process.env.NEXT_PUBLIC_LITE_BUILD_ID?.trim() || makeBuildId({ version, commit }),
};

if (dryRun) {
  runPrepare({ argv: ["--dry-run"], env });
  console.log("[lite] would run: next build --turbopack with", {
    LITE_TARGET: target,
    LITE_BUILD_ID: env.NEXT_PUBLIC_LITE_BUILD_ID,
    LITE_JMAP_SERVER_URL: env.LITE_JMAP_SERVER_URL ?? "",
    LITE_APP_NAME: env.LITE_APP_NAME ?? "",
    LITE_LOCALES: env.LITE_LOCALES ?? "(all)",
    LITE_DEMO_MODE: env.LITE_DEMO_MODE ?? "false",
    NEXT_PUBLIC_BASE_PATH: env.NEXT_PUBLIC_BASE_PATH ?? "",
  });
  process.exit(0);
}

if (!argv.includes("--skip-prepare")) {
  runPrepare({ argv: argv.filter((a) => a === "--in-place"), env });
}

// The Outlook PST import worker is a file in public/, which the export copies.
const pstWorker = await buildPstWorker();
console.log(`[lite] PST import worker ${pstWorker.bytes} bytes`);

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next", { paths: [repoRoot] });
console.log(`[lite] next build --turbopack (static export, ${target} target, build ${env.NEXT_PUBLIC_LITE_BUILD_ID})`);
const build = spawnSync(process.execPath, [nextBin, "build", "--turbopack"], { cwd: repoRoot, env, stdio: "inherit" });
if (build.status !== 0) {
  console.error(`[lite] next build failed with exit code ${build.status}`);
  process.exit(build.status ?? 1);
}

if (env.BULWARK_SOURCE_MAPS === "1") {
  const out = env.SOURCEMAPS_OUT?.trim() || join(repoRoot, "sourcemaps", `lite-${target}`);
  const moved = collectSourceMaps([join(repoRoot, "out", "_next", "static")], out);
  console.log(`[lite] moved ${moved.length} source maps to ${out}`);
}

runPostbuild({ env });

const { problems, locales, apiStrings, zipBytes } = verifyExport({ target });
if (problems.length > 0) {
  console.error(`[lite] verification failed (${problems.length} problems):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const shipped = [join(repoRoot, "out"), join(repoRoot, STALWART_ZIP_NAME)].filter((p) => existsSync(p));
const mapProblems = shipped.flatMap((p) => checkSourceMaps(p).map((problem) => `${p}: ${problem}`));
if (mapProblems.length > 0) {
  console.error(`[lite] source maps would ship (${mapProblems.length}):`);
  for (const p of mapProblems.slice(0, 20)) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[lite] done: out/ holds ${locales.length} locales; ${apiStrings.length} documented /api strings in chunks${zipBytes ? `; zip ${(zipBytes / 1024 / 1024).toFixed(1)} MB` : ""}`);
