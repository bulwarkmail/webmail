#!/usr/bin/env node
// Writes the deployer-facing files into out/ after `next build` exported the
// shells: runtime config, policy, manifest, the root locale shim and the host
// snippets. Everything is derived from the LITE_* env the build ran with.
//
// The Stalwart target (`LITE_TARGET=stalwart`) writes a different set: the
// entry document Stalwart serves for every route, config/policy/manifest that
// follow the runtime mount, no host snippets, no 404.html - and packs out/
// into bulwark-lite-stalwart.zip.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  STALWART_EXCLUDED_DIRS, STALWART_EXCLUDED_FILES, STALWART_ZIP_NAME,
  buildCaddyExample, buildConnectorCapabilities, buildHeaders, buildLiteConfig, buildLitePolicy, buildManifest, buildNginxExample, buildNotFoundShim, buildReadme, buildRedirects, buildRootRedirect,
  buildStalwartEntry, buildStalwartManifest, buildStalwartReadme, buildZip, collectZipEntries, discoverBuiltLocales, discoverShellDirs, findSegmentPrefetchDirs, isMainModule, makeBuildId, normalizeBasePath, parseLiteTarget, resolveRepoRoot,
  withScriptHashCsp,
} from "./lib.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

export function runPostbuild({ root = repoRoot, env = process.env, log = console.log } = {}) {
  const outDir = join(root, "out");
  if (!existsSync(outDir)) throw new Error(`[lite] ${outDir} does not exist - run the export first`);

  const target = parseLiteTarget([], env);
  const basePath = normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH);
  if (target === "stalwart" && basePath) throw new Error("[lite] the Stalwart target learns its mount prefix at runtime; unset NEXT_PUBLIC_BASE_PATH");
  const locales = discoverBuiltLocales(outDir);
  if (locales.length === 0) throw new Error("[lite] no locale shells found under out/ (expected out/<locale>/mail/index.html)");
  const defaultLocale = (env.NEXT_PUBLIC_DEFAULT_LOCALE ?? "").trim() || "en";

  let version = "0.0.0";
  try {
    version = readFileSync(join(root, "VERSION"), "utf8").trim();
  } catch {
    // no VERSION file
  }
  const commit = (env.GIT_COMMIT ?? "").trim().slice(0, 7) || "local";
  const buildId = (env.NEXT_PUBLIC_LITE_BUILD_ID ?? "").trim() || makeBuildId({ version, commit });

  const config = buildLiteConfig(env, { target });
  const files = target === "stalwart"
    ? stalwartFiles({ outDir, config, locales, defaultLocale, version, commit, buildId })
    : staticFiles({ config, basePath, locales, defaultLocale, version, commit });
  files["lite-build.json"] = JSON.stringify({ version, commit, target, buildId, basePath, locales, builtAt: new Date().toISOString() }, null, 2) + "\n";

  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content);
  }
  // The Stalwart target rewrites its shells at runtime, so their scripts
  // cannot be hashed at build time (see buildStalwartEntryCsp).
  if (target === "static") {
    const pages = applyScriptHashCsp(outDir);
    log(`[lite] pinned the inline scripts of ${pages} pages with a <meta> CSP`);
  }
  log(`[lite] wrote ${Object.keys(files).length} files into out/ (${target} target, ${locales.length} locales, base path ${target === "stalwart" ? "runtime" : basePath || "/"})`);

  let zipPath = null;
  if (target === "stalwart") {
    zipPath = join(root, STALWART_ZIP_NAME);
    const zip = buildZip(collectZipEntries(outDir));
    writeFileSync(zipPath, zip);
    log(`[lite] packed ${STALWART_ZIP_NAME}: ${(zip.length / 1024 / 1024).toFixed(1)} MB`);
  }
  return { outDir, locales, basePath, target, buildId, zipPath, files: Object.keys(files) };
}

function staticFiles({ config, basePath, locales, defaultLocale, version, commit }) {
  const connectSrc = config.allowCustomJmapEndpoint || !config.jmapServerUrl ? "*" : new URL(config.jmapServerUrl).origin;
  return {
    "config.json": JSON.stringify(config, null, 2) + "\n",
    "policy.json": JSON.stringify(buildLitePolicy(), null, 2) + "\n",
    // The file form of /api/connector/capabilities - a static export has no
    // route handlers, and a connector probing this instance needs an answer.
    "connector.json": buildConnectorCapabilities({ appName: config.appName, version, basePath }),
    "manifest.webmanifest": JSON.stringify(buildManifest({ appName: config.appName, basePath }), null, 2) + "\n",
    "index.html": buildRootRedirect({ basePath, locales, defaultLocale }),
    // Replaces Next's default not-found page: only this shim replays deep links
    // on hosts without rewrite rules (see buildNotFoundShim).
    "404.html": buildNotFoundShim({ basePath, locales }),
    "_redirects": buildRedirects({ basePath, locales }),
    "_headers": buildHeaders({ basePath, connectSrc }),
    "nginx.conf.example": buildNginxExample({ basePath, connectSrc }),
    "Caddyfile.example": buildCaddyExample({ basePath, connectSrc }),
    "LITE-README.md": buildReadme({ version, commit, basePath, locales, jmapServerUrl: config.jmapServerUrl, demoMode: config.demoMode }),
  };
}

function stalwartFiles({ outDir, config, locales, defaultLocale, version, commit, buildId }) {
  // Next's default not-found page and the static-host helpers have no place
  // in a bundle Stalwart serves: unknown paths always get the entry document.
  for (const name of STALWART_EXCLUDED_FILES) rmSync(join(outDir, name), { force: true });
  for (const name of STALWART_EXCLUDED_DIRS) rmSync(join(outDir, name), { recursive: true, force: true });
  for (const dir of findSegmentPrefetchDirs(outDir)) rmSync(dir, { recursive: true, force: true });
  // Stalwart serves .mjs as application/octet-stream, which browsers refuse
  // for module workers (pdf.js); lib/lite.ts liteMountedAssetUrl asks for these.
  for (const { name, data } of collectZipEntries(join(outDir, "_next"))) {
    if (name.endsWith(".mjs")) writeFileSync(join(outDir, "_next", `${name.slice(0, -4)}.js`), data);
  }
  const shellLocale = locales.includes(defaultLocale) ? defaultLocale : locales[0];
  const shells = discoverShellDirs(outDir, shellLocale);
  return {
    "index.html": buildStalwartEntry({ locales, shells, defaultLocale, buildId, appName: config.appName }),
    "config.json": JSON.stringify(config, null, 2) + "\n",
    "policy.json": JSON.stringify(buildLitePolicy(), null, 2) + "\n",
    "manifest.json": JSON.stringify(buildStalwartManifest({ appName: config.appName }), null, 2) + "\n",
    "LITE-README.md": buildStalwartReadme({ version, commit, locales, buildId, demoMode: config.demoMode }),
  };
}

/** Add each HTML file's script-hash policy (withScriptHashCsp); returns how many. */
export function applyScriptHashCsp(outDir) {
  let pages = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "_next") walk(path);
      } else if (entry.name.endsWith(".html")) {
        writeFileSync(path, withScriptHashCsp(readFileSync(path, "utf8")));
        pages++;
      }
    }
  };
  walk(outDir);
  return pages;
}

if (isMainModule(import.meta.url)) {
  try {
    runPostbuild();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
