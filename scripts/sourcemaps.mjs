#!/usr/bin/env node
// Source maps: built in CI (BULWARK_SOURCE_MAPS=1), uploaded to the error
// tracker, never shipped. https://bulwarkmail.org/docs/deployment/monitoring
//
//   node scripts/sourcemaps.mjs collect --out <dir> <root>...
//     Moves every .map under each root into <dir>/<n>/... with a copy of the
//     .js/.css file that names it (sentry-cli uploads the pairs), and removes
//     the `sourceMappingURL` comment from the shipped file. The chunk keeps
//     its `debugId` comment and registration, which is all the tracker needs.
//
//   node scripts/sourcemaps.mjs check <dir|.zip|.tar.gz>...
//     Fails when anything that would ship holds a .map file, an inline
//     (data:) source map, or a `sourceMappingURL` to a file that isn't there.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// At the start of a line, as bundlers write it; the same text inside a
// string literal is not a reference.
const COMMENT = /^[ \t]*\/[/*][#@][ \t]*sourceMappingURL=([^\s*'"`]+)[ \t]*(?:\*\/)?[ \t]*$/gm;
const SCRIPT = /\.(?:js|mjs|cjs|css)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** The sourceMappingURL targets named in a file's text. */
export function mapReferences(text) {
  return [...text.matchAll(COMMENT)].map((m) => m[1]);
}

/** Remove the sourceMappingURL comments; everything else stays as it is. */
export function stripReferences(text) {
  return text.replace(COMMENT, "").replace(/\n{2,}$/, "\n");
}

export function collect(roots, outDir) {
  const moved = [];
  mkdirSync(outDir, { recursive: true });
  roots.forEach((given, index) => {
    // Absolute, so the maps a file names (resolved below) match the walked paths.
    const root = resolve(given);
    if (!existsSync(root)) return;
    const files = walk(root);
    const maps = new Set(files.filter((f) => f.endsWith(".map")));
    const target = join(outDir, String(index));
    for (const file of files.filter((f) => SCRIPT.test(f))) {
      const text = readFileSync(file, "utf8");
      const refs = mapReferences(text);
      if (refs.length === 0) continue;
      for (const ref of refs) {
        if (ref.startsWith("data:")) continue;
        const map = resolve(dirname(file), decodeURIComponent(ref));
        if (!maps.has(map)) continue;
        for (const source of [file, map]) {
          const dest = join(target, relative(root, source));
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(source, dest);
        }
      }
      writeFileSync(file, stripReferences(text));
    }
    // Every map goes, named by a file or not.
    for (const map of maps) {
      const dest = join(target, relative(root, map));
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(map, dest);
      }
      rmSync(map);
      moved.push(map);
    }
  });
  return moved;
}

// --- archives -------------------------------------------------------------

function zipEntries(buffer) {
  const entries = [];
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    entries.push({ name, read: () => (method === 0 ? raw : inflateRawSync(raw)) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function tarEntries(buffer) {
  const entries = [];
  let at = 0;
  let longName = null;
  while (at + 512 <= buffer.length) {
    const header = buffer.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const data = buffer.subarray(at + 512, at + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "") entries.push({ name, read: () => data });
    else if (type === "x") {
      const path = /\d+ path=([^\n]+)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function filesOf(path) {
  if (statSync(path).isDirectory()) {
    return walk(path).map((file) => ({ name: relative(path, file).split(sep).join("/"), read: () => readFileSync(file) }));
  }
  const buffer = readFileSync(path);
  if (path.endsWith(".zip")) return zipEntries(buffer);
  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) return tarEntries(gunzipSync(buffer));
  if (path.endsWith(".tar")) return tarEntries(buffer);
  throw new Error(`don't know how to read ${path}`);
}

/** Problems with what would ship at `path`; empty when it is clean. */
export function check(path) {
  const problems = [];
  const entries = filesOf(path);
  const names = new Set(entries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.name.endsWith(".map")) {
      problems.push(`${entry.name}: source map file`);
      continue;
    }
    if (!SCRIPT.test(entry.name)) continue;
    for (const ref of mapReferences(entry.read().toString("utf8"))) {
      if (ref.startsWith("data:")) {
        problems.push(`${entry.name}: inline source map`);
        continue;
      }
      const target = join(dirname(entry.name), decodeURIComponent(ref)).split(sep).join("/");
      if (!names.has(target)) problems.push(`${entry.name}: sourceMappingURL to missing ${ref}`);
    }
  }
  return problems;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "collect") {
    const at = rest.indexOf("--out");
    if (at < 0 || !rest[at + 1]) throw new Error("collect needs --out <dir>");
    const out = rest[at + 1];
    const roots = rest.filter((_, i) => i !== at && i !== at + 1);
    const moved = collect(roots, out);
    console.log(`[sourcemaps] moved ${moved.length} maps out of ${roots.join(", ")} into ${out}`);
    return 0;
  }
  if (command === "check") {
    let failed = false;
    for (const path of rest) {
      if (!existsSync(path)) {
        console.error(`[sourcemaps] ${path}: not found`);
        failed = true;
        continue;
      }
      const problems = check(path);
      if (problems.length) {
        failed = true;
        console.error(`[sourcemaps] ${basename(path)}: ${problems.length} problem(s)`);
        for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
      } else {
        console.log(`[sourcemaps] ${path}: no source maps`);
      }
    }
    return failed ? 1 : 0;
  }
  console.error("usage: sourcemaps.mjs collect --out <dir> <root>... | check <path>...");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
