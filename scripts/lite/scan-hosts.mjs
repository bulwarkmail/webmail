#!/usr/bin/env node
// Scans a finished Lite export for outside hosts (#903). Every http(s) or
// ws(s) host literal, and every protocol-relative //host in a string, must be
// the configured JMAP server, a placeholder, one of Bulwark's built-in outside
// hosts (switched off at runtime by noThirdPartyTraffic) or a known string
// that is never requested, in the kind of file it is listed for. Anything else
// fails the build in CI (.github/workflows/static-lite.yml).
//
//   node scripts/lite/scan-hosts.mjs [outDir=out]
//
// LITE_BUILT_IN_HOSTS mirrors BUILT_IN_HOSTNAMES in lib/outgoing-hosts.ts (a
// TS module this script cannot import); lib/__tests__/lite-bundle-hosts.test.ts
// pins the two together.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isMainModule, resolveRepoRoot } from "./lib.mjs";

export const LITE_BUILT_IN_HOSTS = [
  "telemetry.bulwarkmail.org",
  "version.telemetry.bulwarkmail.org",
  "notifications.relay.bulwarkmail.org",
  "extensions.bulwarkmail.org",
  "connector.bulwarkmail.org",
  "icons.duckduckgo.com",
  "api.mymemory.translated.net",
  "www.google.com",
  "randomuser.me",
  "img.freepik.com",
  "openpgpkey.",
];

const CHUNKS = /^_next\/static\/chunks\/[^/]+\.js$/;
const PAGES = /\.(html|txt)$/;

/** Strings in the bundle that are never requested, by where they may appear and why. */
export const LITE_BUNDLE_NON_REQUEST = [
  { files: CHUNKS, why: "Bulwark's built-in hosts, off at runtime with noThirdPartyTraffic", hosts: LITE_BUILT_IN_HOSTS },
  { files: CHUNKS, why: "error and docs links of bundled libraries (Next.js, React, JSZip, ProseMirror, core-js, date-fns)", hosts: ["nextjs.org", "react.dev", "stuk.github.io", "prosemirror.net", "github.com", "foo.bar"] },
  { files: CHUNKS, why: "example addresses the translations localise", hosts: ["eksempel.dk", "mail.eksempel.dk", "piemers.lv", "pasts.piemers.lv", "ornek.com", "mail.ornek.com"] },
  { files: CHUNKS, why: "links inside the sample mail of the demo mode (lib/demo/fixtures)", hosts: ["zoom.us", "notion.so", "www.figma.com", "vercel.com", "i.scdn.co", "cf.bstatic.com", "open.spotify.com", "linear.app", "sentry.io", "app.docusign.com", "github.com", "bulwark-webmail.vercel.app"] },
  { files: CHUNKS, why: "JMAP capability URI and XML namespaces", hosts: ["bulwarkmail.com", "www.w3.org", "creativecommons.org"] },
  { files: CHUNKS, why: "schema.org vocabulary names in booking markup (lib/structured-mail), matched and never requested", hosts: ["schema.org"] },
  { files: /./, why: "docs links in the translations and the README", hosts: ["bulwarkmail.org", "github.com"] },
  { files: PAGES, why: "XML namespaces of inline SVG", hosts: ["www.w3.org"] },
  { files: /^_next\/static\/chunks\/[^/]+\.css$/, why: "XML namespace of the SVG pointers in app/accessibility.css (large mouse pointer)", hosts: ["www.w3.org"] },
  { files: /^_next\/static\/media\/pdf\.worker[^/]*\.m?js$/, why: "XML namespaces and the licence link inside pdf.js", hosts: ["www.apache.org", "www.w3.org", "www.xfa.org", "ns.adobe.com"] },
  { files: /^pst-worker\.js$/, why: "licence links in the bundled licence comments of buffer, ieee754 and long (scripts/build-pst-worker.mjs)", hosts: ["feross.org", "www.apache.org"] },
];

const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost", "local", "internal", "lan"]);

function isReservedIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/** Same rule as isPlaceholderHost in lib/admin/outgoing-hosts-registry.ts. */
export function isPlaceholderHost(raw) {
  const host = raw.toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
  if (/^[\d.]+$/.test(host)) return isReservedIPv4(host);
  if (!host.includes(".") || host.includes("*")) return true;
  const tld = host.split(".").pop();
  if (RESERVED_TLDS.has(tld)) return true;
  return /(^|\.)example\.(com|org|net)$/.test(host);
}

const SCHEME_HOST = /\b(?:https?|wss?):\/\/([a-z0-9.*_-]+)/gi;
const PROTOCOL_RELATIVE = /["'`]\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

export function bundleHosts(text) {
  const out = [];
  for (const m of text.matchAll(SCHEME_HOST)) out.push(m[1].toLowerCase());
  for (const m of text.matchAll(PROTOCOL_RELATIVE)) out.push(m[1].toLowerCase());
  return out;
}

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(js|mjs|html|css|json|txt|webmanifest|md|example)$/.test(name) || name === "_headers") out.push(full);
  }
  return out;
}

/** "file: host" for every host in `outDir` that isn't accounted for. */
export function scanBundleHosts(outDir) {
  let jmapHost = null;
  try {
    const config = JSON.parse(readFileSync(join(outDir, "config.json"), "utf8"));
    if (config.jmapServerUrl) jmapHost = new URL(config.jmapServerUrl).host.toLowerCase();
  } catch { /* no config: nothing configured */ }
  const problems = new Set();
  for (const full of files(outDir)) {
    const file = relative(outDir, full).split(sep).join("/");
    for (const raw of bundleHosts(readFileSync(full, "utf8"))) {
      const host = raw.replace(/\.{2,}$/, "");
      if (host === jmapHost) continue;
      const listed = LITE_BUNDLE_NON_REQUEST.some((entry) => entry.files.test(file) && (entry.hosts.includes(raw) || entry.hosts.includes(host)));
      if (listed) continue;
      const known = LITE_BUNDLE_NON_REQUEST.some((entry) => entry.hosts.includes(host));
      if (!known && isPlaceholderHost(host)) continue;
      problems.add(`${file}: ${host}`);
    }
  }
  return [...problems];
}

if (isMainModule(import.meta.url)) {
  const outDir = process.argv[2] ?? join(resolveRepoRoot(import.meta.url), "out");
  const problems = scanBundleHosts(outDir);
  if (problems.length > 0) {
    console.error(`[lite] ${problems.length} outside host(s) in the bundle that aren't accounted for (scripts/lite/scan-hosts.mjs):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[lite] no unaccounted outside hosts in the bundle");
}
