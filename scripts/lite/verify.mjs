#!/usr/bin/env node
// Guards for a finished Lite export: the files a deployer relies on exist,
// and the client chunks reference no server endpoint outside the documented
// allowlist (lib.mjs). Exit 1 with a readable list otherwise.
//
// The Stalwart target additionally checks the entry document (both literals
// Stalwart rewrites, exactly once; nothing root-absolute; a policy that runs
// no inline script but its own), every other page (no inline script, the same
// policy), the zip layout and its size against Stalwart's 100 MB limit.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LITE_PENDING_PATH_KEY, STALWART_BOOT_FILE, STALWART_EXCLUDED_FILES, STALWART_MAX_BUNDLE_BYTES, STALWART_SAFE_BUNDLE_BYTES, STALWART_SCRIPT_DIR, STALWART_ZIP_NAME,
  collectApiStrings, collectZipEntries, discoverBuiltLocales, flightTextRowsWithNeedles, frameGuardProblems, inlineScriptHashes, isMainModule, listZipEntries, parseLiteTarget, resolveRepoRoot, stalwartEntryProblems, stalwartShellProblems, stalwartZipEntryProblems, unexpectedApiStrings, unexpectedEngineFiles,
} from "./lib.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

/** The target recorded by postbuild, so `node verify.mjs` needs no flags. */
function recordedTarget(outDir) {
  try {
    return JSON.parse(readFileSync(join(outDir, "lite-build.json"), "utf8")).target ?? "static";
  } catch {
    return "static";
  }
}

/**
 * @param {{ root?: string, target?: "static" | "stalwart", safeBundleBytes?: number }} [options]
 *   `target` defaults to the one postbuild recorded in out/lite-build.json.
 */
export function verifyExport({ root = repoRoot, target, safeBundleBytes = STALWART_SAFE_BUNDLE_BYTES } = {}) {
  const outDir = join(root, "out");
  const problems = [];
  const resolvedTarget = target ?? recordedTarget(outDir);

  const locales = discoverBuiltLocales(outDir);
  if (locales.length === 0) problems.push("no locale shells found (out/<locale>/mail/index.html)");

  for (const locale of locales) {
    for (const surface of ["mail", "calendar", "contacts", "files", "settings", "login"]) {
      if (!existsSync(join(outDir, locale, surface, "index.html"))) problems.push(`missing out/${locale}/${surface}/index.html`);
    }
    if (!existsSync(join(outDir, locale, "index.html"))) problems.push(`missing out/${locale}/index.html`);
  }

  const required = resolvedTarget === "stalwart"
    ? ["index.html", "config.json", "policy.json", "manifest.json", "LITE-README.md", "lite-build.json", STALWART_BOOT_FILE]
    // connector.json is the static target only: the Stalwart bundle is served
    // without custom headers, so a connector's cross-origin probe could not
    // read it anyway (it falls back to adding the instance unverified).
    : ["index.html", "404.html", "config.json", "policy.json", "connector.json", "manifest.webmanifest", "_redirects", "_headers", "LITE-README.md", "lite-build.json"];
  for (const file of required) {
    if (!existsSync(join(outDir, file))) problems.push(`missing out/${file}`);
  }
  for (const file of ["_next/static", "branding"]) {
    if (!existsSync(join(outDir, file))) problems.push(`missing out/${file}`);
  }

  if (resolvedTarget !== "stalwart") {
    // Next writes its own default not-found page as 404.html; postbuild must
    // have replaced it with the shim that parks and replays deep links.
    const notFound = join(outDir, "404.html");
    if (existsSync(notFound) && !readFileSync(notFound, "utf8").includes(LITE_PENDING_PATH_KEY)) {
      problems.push("out/404.html is not the Lite shim (deep links on hosts without rewrites would dead-end); run postbuild");
    }
    // Every page pins its inline scripts (postbuild applyScriptHashCsp); a
    // page changed afterwards would load with its hydration scripts blocked.
    for (const locale of locales) {
      for (const surface of ["mail", "calendar", "contacts", "files", "settings", "login"]) {
        const page = join(outDir, locale, surface, "index.html");
        if (!existsSync(page)) continue;
        const html = readFileSync(page, "utf8");
        const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
        if (!policy) problems.push(`out/${locale}/${surface}/index.html carries no script policy; run postbuild`);
        else if (inlineScriptHashes(html).some((hash) => !policy.includes(hash))) {
          problems.push(`out/${locale}/${surface}/index.html has an inline script its policy does not allow`);
        }
        // A <meta> can't carry frame-ancestors: the page refuses foreign frames itself.
        for (const p of frameGuardProblems(html)) problems.push(`out/${locale}/${surface}/index.html ${p}; run postbuild`);
      }
    }
  }

  const apiStrings = collectApiStrings(join(outDir, "_next", "static"));
  const unexpected = unexpectedApiStrings(apiStrings);
  for (const s of unexpected) problems.push(`client chunk references undocumented server endpoint ${s} (add an IS_LITE gate or document it in scripts/lite/lib.mjs)`);

  if (existsSync(outDir)) {
    for (const file of unexpectedEngineFiles(collectZipEntries(outDir).map(({ name }) => name))) problems.push(`out/${file} is the local store's engine, which Lite must not ship`);
  }

  let zipBytes = 0;
  if (resolvedTarget === "stalwart") {
    const entry = join(outDir, "index.html");
    if (existsSync(entry)) problems.push(...stalwartEntryProblems(readFileSync(entry, "utf8")).map((p) => `out/${p}`));
    // The entry's policy stays on the document a shell is written into: a
    // shell must not need inline script, and carries the policy itself.
    const shipped = existsSync(outDir) ? collectZipEntries(outDir) : [];
    const names = new Set(shipped.map(({ name }) => name));
    for (const { name, data } of shipped) {
      if (!name.endsWith(".html") || name === "index.html" || name.startsWith("_next/")) continue;
      const html = data.toString("utf8");
      for (const p of stalwartShellProblems(html)) problems.push(`out/${name} ${p}`);
      for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="\/([^"?#]+)/gi)) {
        if (src.startsWith(`${STALWART_SCRIPT_DIR}/`) && !names.has(src)) problems.push(`out/${name} loads /${src}, which is missing`);
      }
    }
    for (const file of STALWART_EXCLUDED_FILES) {
      if (existsSync(join(outDir, file))) problems.push(`out/${file} belongs to the static-host target`);
    }
    // The runtime mount rewrite skips length-prefixed RSC text rows.
    for (const { name, data } of existsSync(outDir) ? collectZipEntries(outDir) : []) {
      if (!name.endsWith(".txt")) continue;
      const rows = flightTextRowsWithNeedles(data.toString("utf8"));
      if (rows.length) problems.push(`out/${name}: RSC text rows ${rows.join(", ")} hold root-absolute URLs the mount rewrite cannot reach`);
    }
    const zipPath = join(root, STALWART_ZIP_NAME);
    if (!existsSync(zipPath)) {
      problems.push(`missing ${STALWART_ZIP_NAME} (postbuild packs it)`);
    } else {
      zipBytes = statSync(zipPath).size;
      const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (zipBytes > STALWART_MAX_BUNDLE_BYTES) problems.push(`${STALWART_ZIP_NAME} is ${mb(zipBytes)}; Stalwart refuses bundles above ${mb(STALWART_MAX_BUNDLE_BYTES)}`);
      else if (zipBytes > safeBundleBytes) problems.push(`${STALWART_ZIP_NAME} is ${mb(zipBytes)}, above the ${mb(safeBundleBytes)} safety margin under Stalwart's ${mb(STALWART_MAX_BUNDLE_BYTES)} limit`);
      try {
        problems.push(...stalwartZipEntryProblems(listZipEntries(readFileSync(zipPath)).map((e) => e.name)).map((p) => `${STALWART_ZIP_NAME}: ${p}`));
      } catch (err) {
        problems.push(`${STALWART_ZIP_NAME} cannot be read: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return { problems, locales, apiStrings, target: resolvedTarget, zipBytes };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const target = argv.some((a) => a.startsWith("--target")) || process.env.LITE_TARGET ? parseLiteTarget(argv, process.env) : undefined;
  const { problems, locales, apiStrings, target: checked, zipBytes } = verifyExport({ target });
  if (problems.length > 0) {
    console.error(`[lite] verification failed (${problems.length} problems):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[lite] ${checked} export verified: ${locales.length} locales, ${apiStrings.length} known /api strings in chunks${zipBytes ? `, zip ${(zipBytes / 1024 / 1024).toFixed(1)} MB` : ""}`);
}
