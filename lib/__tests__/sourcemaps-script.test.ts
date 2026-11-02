// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check, collect, mapReferences } from '../../scripts/sourcemaps.mjs';
import { buildZip } from '../../scripts/lite/lib.mjs';

// CI builds source maps for the error tracker; none may ship (images, the
// standalone tarball, Lite zips).

let dir: string;
const put = (rel: string, text: string) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'bulwark-maps-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('collect', () => {
  it('moves maps out with the chunks that name them, and strips the comment from what ships', () => {
    put('static/chunks/a.js', 'console.log(1);\n//# debugId=bc67f7db-7f3b-7be2-6f94-966cd7825cc2\n//# sourceMappingURL=a1b2.js.map\n');
    put('static/chunks/a1b2.js.map', '{"version":3}');
    put('static/css/x.css', 'a{}\n/*# sourceMappingURL=x.css.map */\n');
    put('static/css/x.css.map', '{"version":3}');
    put('static/chunks/orphan.js.map', '{"version":3}');
    const out = path.join(dir, 'maps');

    const moved = collect([path.join(dir, 'static')], out);

    expect(moved).toHaveLength(3);
    expect(existsSync(path.join(dir, 'static/chunks/a1b2.js.map'))).toBe(false);
    const shipped = readFileSync(path.join(dir, 'static/chunks/a.js'), 'utf8');
    expect(mapReferences(shipped)).toEqual([]);
    expect(shipped).toContain('//# debugId=bc67f7db-7f3b-7be2-6f94-966cd7825cc2');
    expect(readFileSync(path.join(out, '0/chunks/a.js'), 'utf8')).toContain('sourceMappingURL=a1b2.js.map');
    expect(existsSync(path.join(out, '0/chunks/a1b2.js.map'))).toBe(true);
    expect(existsSync(path.join(out, '0/chunks/orphan.js.map'))).toBe(true);
    expect(check(path.join(dir, 'static'))).toEqual([]);
  });
});

describe('collect with a relative root', () => {
  it('still copies the chunk that names each map', () => {
    put('rel/chunks/b.js', 'x\n//# sourceMappingURL=b.js.map\n');
    put('rel/chunks/b.js.map', '{"version":3}');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      collect(['rel'], 'out');
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(path.join(dir, 'out/0/chunks/b.js'))).toBe(true);
    expect(existsSync(path.join(dir, 'out/0/chunks/b.js.map'))).toBe(true);
    expect(mapReferences(readFileSync(path.join(dir, 'rel/chunks/b.js'), 'utf8'))).toEqual([]);
  });
});

describe('check', () => {
  it('finds map files, dangling references and inline maps in a folder', () => {
    put('a/x.js.map', '{}');
    put('a/y.js', 'x\n//# sourceMappingURL=gone.js.map\n');
    put('a/z.js', 'x\n//# sourceMappingURL=data:application/json;base64,e30=\n');
    put('a/ok.js', 'const s = "//# sourceMappingURL=in-a-string.map";\n');
    expect(check(path.join(dir, 'a')).sort()).toEqual([
      'x.js.map: source map file',
      'y.js: sourceMappingURL to missing gone.js.map',
      'z.js: inline source map',
    ]);
  });

  it('reads zip archives', () => {
    const zip = path.join(dir, 'lite.zip');
    writeFileSync(zip, buildZip([
      { name: '_next/static/chunks/a.js', data: Buffer.from('x\n//# sourceMappingURL=a.js.map\n') },
      { name: '_next/static/chunks/a.js.map', data: Buffer.from('{}') },
    ]));
    expect(check(zip)).toEqual(['_next/static/chunks/a.js.map: source map file']);
    writeFileSync(zip, buildZip([{ name: 'index.html', data: Buffer.from('<html>') }]));
    expect(check(zip)).toEqual([]);
  });

  it('reads gzipped tarballs', () => {
    const tgz = path.join(dir, 'standalone.tar.gz');
    writeFileSync(tgz, gzipSync(tar({
      'bulwark-standalone/.next/server/chunks/1.js': 'x\n//# sourceMappingURL=1.js.map\n',
      'bulwark-standalone/.next/server/chunks/1.js.map': '{}',
    })));
    expect(check(tgz)).toEqual(['bulwark-standalone/.next/server/chunks/1.js.map: source map file']);
  });
});
