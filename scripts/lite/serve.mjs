#!/usr/bin/env node
// Dependency-free static server for a Lite export, applying the same SPA
// fallback the shipped nginx/Caddy snippets do. Used by the Playwright smoke
// test and handy for a local look at out/:
//
//   node scripts/lite/serve.mjs [outDir=out] [port=4173] [basePath=] [--plain]
//
// `--plain` switches the SPA fallback off and answers unknown paths with
// 404.html (status 404), the way GitHub Pages or an S3 bucket would; that is
// the path the 404 shim's park-and-replay exists for.
//
// `--stalwart=/webmail[,/other]` emulates a Stalwart Application instead
// (emulateStalwartRequest in lib.mjs): exact entry lookup, the root
// index.html for everything else with <base href> and the OAuth meta tag
// rewritten, no-cache vs immutable, Stalwart's extension -> MIME map, its
// reserved first segments. The source may be out/ or the zip itself:
//
//   node scripts/lite/serve.mjs bulwark-lite-stalwart.zip 4180 --stalwart=/webmail,/bulwark
//     [--oauth-client-id=my-client] [--legacy] [--upstream=http://127.0.0.1:18081]
//
// `--upstream` forwards Stalwart's own routes (/jmap, /api, /auth,
// /.well-known, ...) to a real server, so the app stays same-origin with it.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { LITE_SURFACES, collectZipEntries, emulateStalwartRequest, isReservedStalwartSegment, listZipEntries, readZipEntry } from "./lib.mjs";

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const hit = flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const plain = flag("plain") !== undefined;
const stalwartPrefixes = flag("stalwart");
const root = resolve(args[0] || "out");
const port = Number(args[1] || 4173);
const basePath = (args[2] || "").replace(/\/+$/, "");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

function send(res, file, status = 200) {
  res.writeHead(status, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function fileFor(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const direct = join(root, rel);
  if (!direct.startsWith(root)) return null;
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const index = join(direct, "index.html");
  if (existsSync(index)) return index;
  const html = `${direct}.html`;
  if (existsSync(html)) return html;
  return null;
}

const surfacePattern = new RegExp(`^/([^/]+)/(${LITE_SURFACES.join("|")})(?:/|$)`);

export function resolveRequest(pathname) {
  if (basePath) {
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return { status: 404, file: join(root, "404.html") };
    pathname = pathname.slice(basePath.length) || "/";
  }
  const file = fileFor(pathname);
  if (file) return { status: 200, file };
  const match = plain ? null : pathname.match(surfacePattern);
  if (match) {
    const shell = join(root, match[1], match[2], "index.html");
    if (existsSync(shell)) return { status: 200, file: shell };
  }
  return { status: 404, file: join(root, "404.html") };
}

/** Zip entries (or the files of an unpacked out/) by entry name. */
function loadEntries(source) {
  if (source.endsWith(".zip")) {
    const buffer = readFileSync(source);
    return new Map(listZipEntries(buffer).map((entry) => [entry.name, readZipEntry(buffer, entry)]));
  }
  return new Map(collectZipEntries(source).map(({ name, data }) => [name, data]));
}

function proxy(req, res, upstream) {
  const target = new URL(req.url ?? "/", upstream);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: target.host };
  const out = send(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(out);
}

if (stalwartPrefixes !== undefined) {
  const prefixes = stalwartPrefixes.split(",").map((p) => p.trim()).filter(Boolean);
  if (prefixes.length === 0) throw new Error("--stalwart needs at least one prefix, e.g. --stalwart=/webmail");
  const oauthClientId = flag("oauth-client-id") ?? "";
  const legacy = flag("legacy") !== undefined;
  const upstream = flag("upstream");
  let entries = loadEntries(root);
  let loadedAt = Date.now();
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Reload when the source changes, like Stalwart picking up a new bundle.
    try {
      if (statSync(root).mtimeMs > loadedAt) {
        entries = loadEntries(root);
        loadedAt = Date.now();
      }
    } catch {
      // keep the previous bundle, as Stalwart does on a failed refresh
    }
    if (upstream && isReservedStalwartSegment(url.pathname.split("/")[1] ?? "")) return proxy(req, res, upstream);
    const { status, headers, body } = emulateStalwartRequest({ pathname: url.pathname, entries, prefixes, oauthClientId, legacy });
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  }).listen(port, () => {
    console.log(`[lite] Stalwart emulator: ${root} (${entries.size} entries) at ${prefixes.map((p) => `http://localhost:${port}${p.replace(/\/+$/, "")}/`).join(", ")}${upstream ? `, upstream ${upstream}` : ""}${legacy ? " (0.16.0-0.16.18 rewrite)" : ""}`);
  });
} else {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { status, file } = resolveRequest(url.pathname);
    if (file && existsSync(file)) return send(res, file, status);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }).listen(port, () => {
    console.log(`[lite] serving ${root} at http://localhost:${port}${basePath}/${plain ? " (plain: no SPA fallback, 404.html for unknown paths)" : ""}`);
  });
}
