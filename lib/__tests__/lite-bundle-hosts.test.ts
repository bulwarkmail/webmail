// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILT_IN_HOSTNAMES } from '@/lib/outgoing-hosts';
import { isPlaceholderHost as sourcePlaceholder } from '@/lib/admin/outgoing-hosts-registry';
import { LITE_BUILT_IN_HOSTS, isPlaceholderHost, scanBundleHosts } from '../../scripts/lite/scan-hosts.mjs';

// scripts/lite/scan-hosts.mjs runs in the Lite CI job after build:lite (the
// build prunes the test trees, so the scan can't be a vitest file there).
// These tests pin it to the app's host list and show what it catches. With
// LITE_OUT_DIR set it also scans a real build:
//
//   LITE_OUT_DIR=/path/to/out npx vitest run lib/__tests__/lite-bundle-hosts.test.ts

const dirs: string[] = [];
function fakeOut(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lite-out-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('Lite bundle host scan', () => {
  it('knows the same built-in hosts and placeholders as the app', () => {
    expect((LITE_BUILT_IN_HOSTS as string[]).filter((h) => !h.endsWith('.')).sort()).toEqual([...BUILT_IN_HOSTNAMES].sort());
    for (const host of ['mail.example.com', 'x', '10.0.0.5', '93.184.216.34', 'acme.test', 'github.com', '*.vimeo.com']) {
      expect(isPlaceholderHost(host), host).toBe(sourcePlaceholder(host));
    }
  });

  it('passes a bundle with only accounted hosts', () => {
    const out = fakeOut({
      'config.json': JSON.stringify({ jmapServerUrl: 'https://mail.corp.example.net' }),
      '_next/static/chunks/a1.js': 'fetch("https://mail.corp.example.net/jmap");x="https://react.dev/errors/";y="https://icons.duckduckgo.com"',
      'en/mail/index.html': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    });
    expect(scanBundleHosts(out)).toEqual([]);
  });

  it('catches a new host, a ws host, a protocol-relative host, a public IP and a listed host in the wrong file', () => {
    const out = fakeOut({
      'config.json': '{}',
      '_next/static/chunks/b2.js': [
        'fetch("https://beacon.fakecdn.io/x")',
        'new WebSocket("WSS://Live.FakeCDN.io")',
        's.src="//cdn.fakecdn.io/lib.js"',
        'fetch("http://93.184.216.34/")',
      ].join(';'),
      'en/mail/index.html': '<img src="https://icons.duckduckgo.com/x.ico">',
    });
    expect(scanBundleHosts(out).sort()).toEqual([
      '_next/static/chunks/b2.js: 93.184.216.34',
      '_next/static/chunks/b2.js: beacon.fakecdn.io',
      '_next/static/chunks/b2.js: cdn.fakecdn.io',
      '_next/static/chunks/b2.js: live.fakecdn.io',
      'en/mail/index.html: icons.duckduckgo.com',
    ]);
  });

  it('accepts the licence links of the PST worker only in that file', () => {
    const licences = '/*! Bundled license information:\n * @author Feross Aboukhadijeh <https://feross.org>\n *     http://www.apache.org/licenses/LICENSE-2.0\n */';
    const out = fakeOut({
      'config.json': '{}',
      'pst-worker.js': `(()=>{fetch("https://beacon.fakecdn.io/x")})();\n${licences}`,
      '_next/static/chunks/c3.js': licences,
    });
    expect(scanBundleHosts(out).sort()).toEqual([
      '_next/static/chunks/c3.js: feross.org',
      '_next/static/chunks/c3.js: www.apache.org',
      'pst-worker.js: beacon.fakecdn.io',
    ]);
  });

  it.skipIf(!process.env.LITE_OUT_DIR)('finds nothing unaccounted in the build at LITE_OUT_DIR', () => {
    expect(scanBundleHosts(process.env.LITE_OUT_DIR)).toEqual([]);
  });
});
