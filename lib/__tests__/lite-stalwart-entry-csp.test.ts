// Stalwart sends no security headers for an Application, so the <meta> policy
// of the entry document is the only Content-Security-Policy of Lite served by
// Stalwart, and every document the app opens on that origin inherits it. It
// must not let inline script run: the shells the entry writes in carry their
// scripts as files instead.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STALWART_BOOT_FILE,
  STALWART_SCRIPT_DIR,
  buildCsp,
  buildStalwartBootScript,
  buildStalwartEntry,
  buildStalwartEntryCsp,
  inlineScriptHashes,
  moveShellScriptsToFiles,
  rewriteShellForMount,
  stalwartEntryProblems,
  stalwartRewriteIndex,
  stalwartShellProblems,
} from '../../scripts/lite/lib.mjs';
import { runPostbuild } from '../../scripts/lite/postbuild.mjs';
import { verifyExport } from '../../scripts/lite/verify.mjs';

function directive(csp: string, name: string): string[] {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.split(/\s+/)[0] === name);
  return found ? found.split(/\s+/).slice(1) : [];
}

function metaPolicy(html: string): string | null {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? null;
}

describe('the policy of Lite served by Stalwart', () => {
  it('does not let inline script run', () => {
    const scriptSrc = directive(buildStalwartEntryCsp(), 'script-src');
    expect(scriptSrc.length).toBeGreaterThan(0);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('is the policy the entry document carries, ahead of its first script', () => {
    const html = buildStalwartEntry({ locales: ['en'], shells: ['mail', 'login'], defaultLocale: 'en', buildId: 'b1' });
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
    expect(meta).not.toBeNull();
    expect(html.indexOf(meta![0])).toBeLessThan(html.indexOf('<script'));
    expect(directive(meta![1], 'script-src')).not.toContain("'unsafe-inline'");
  });

  // Control: what already holds, so a fix does not loosen it.
  it('still forbids plugins, a moved base and eval', () => {
    const csp = buildStalwartEntryCsp();
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
    expect(directive(buildCsp(), 'frame-ancestors')).toEqual(["'self'"]);
  });

  it("allows the entry's own script by its hash, under any mount and client id", () => {
    const html = buildStalwartEntry({ locales: ['de', 'en'], shells: ['', 'mail'], defaultLocale: 'en', buildId: 'b2' });
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    expect(directive(metaPolicy(html)!, 'script-src')).toEqual(["'self'", hashes[0]]);
    // What Stalwart rewrites is outside the script: the hash still matches.
    for (const [prefix, client] of [['webmail', ''], ['bulwark', 'my"client'], ['x', 'other-id']]) {
      const served = stalwartRewriteIndex(html, prefix, client);
      // (The literals Stalwart replaced are gone from what it serves, as they should be.)
      expect(stalwartEntryProblems(served).filter((p) => /polic|inline script/.test(p)), `${prefix} ${client}`).toEqual([]);
      expect(inlineScriptHashes(served)).toEqual(hashes);
    }
    expect(stalwartRewriteIndex(html, 'webmail', 'ignored', { legacy: true })).toContain(metaPolicy(html));
  });

  it('flags an entry whose policy runs any inline script or misses its script', () => {
    const html = buildStalwartEntry({ locales: ['en'], shells: [''], buildId: 'b' });
    const policy = metaPolicy(html)!;
    expect(stalwartEntryProblems(html.replace(policy, policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))).join('\n')).toMatch(/lets any inline script run/);
    expect(stalwartEntryProblems(html.replace('</head>', '<script>alert(1)</script></head>')).join('\n')).toMatch(/inline script its policy does not allow/);
  });
});

// A shell as Next exports it, cut down: the layout's boot script, Turbopack's
// bootstrap, React's reveal instruction, the RSC payload with chunk, manifest
// and branding URLs, and a data block.
const SHELL = [
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>',
  '<link rel="stylesheet" href="/_next/static/chunks/a.css"/><link rel="manifest" href="/manifest.webmanifest"/>',
  '<script src="/_next/static/chunks/b.js" async=""></script>',
  '<script>\r\n(function(){document.documentElement.dataset.boot="1"})();\r\n</script>',
  '</head><body><div id="x">hi</div>',
  '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["static/chunks/c.js"],"runtimeModuleIds":[1]})</script>',
  '<script async="">$RC("B:0","S:0")</script>',
  '<script type="application/json" id="data">{"href":"/_next/static/x"}</script>',
  '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
  '<script>self.__next_f.push([1,"1:I[1,[\\"/_next/static/chunks/d.js\\"],\\"default\\"]\\n2:{\\"m\\":\\"/manifest.webmanifest\\",\\"i\\":\\"/branding/i.svg\\",\\"t\\":\\"\\u003cb\\u003e Grüße\\"}\\n"])</script>',
  '<script>self.__next_f.push([1,"/_next/static/chunks/e.js"])</script>',
  '<script>self.__next_f.push([1,"3:\\"/manifest.webmanifest"])</script>',
  '</body></html>',
].join('');

/** Runs the scripts of a page in order, inline text or file, with `self` as the global; returns what they pushed. */
function runScripts(html: string, files: Record<string, string>, mount: string) {
  const self: Record<string, unknown> = { __BULWARK_LITE_MOUNT__: mount };
  const ran: string[] = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
    if (/type="application\/json"/.test(attrs)) continue;
    let code: string;
    if (src) {
      const rel = src.slice(mount.length + 1);
      if (!rel.startsWith(`${STALWART_SCRIPT_DIR}/`)) continue; // Next's own chunks
      code = files[rel];
    } else {
      code = body;
    }
    if (code.includes('__next_f')) {
      new Function('self', code)(self);
      ran.push('next_f');
    } else {
      ran.push(code.includes('TURBOPACK') ? 'turbopack' : code.includes('$RC') ? 'reveal' : 'boot');
    }
  }
  return { pushed: self.__next_f, ran };
}

describe('the shells of the Stalwart bundle', () => {
  it('carry no inline script and the same policy as the entry', () => {
    const { html, files } = moveShellScriptsToFiles(SHELL, { buildId: 'b1' });
    expect(inlineScriptHashes(html)).toEqual([]);
    expect(metaPolicy(html)).toBe(buildStalwartEntryCsp());
    expect(html.indexOf('<meta http-equiv')).toBeLessThan(html.indexOf('<script'));
    expect(stalwartShellProblems(html)).toEqual([]);
    expect(stalwartShellProblems(SHELL).join('\n')).toMatch(/carries no script policy[\s\S]*inline scripts/);
    // Seven scripts became files, each referenced once, in place; the data block stays.
    expect(Object.keys(files)).toHaveLength(7);
    for (const name of Object.keys(files)) expect(html.split(`src="/${name}"`)).toHaveLength(2);
    expect(html).toContain('<script type="application/json" id="data">{"href":"/_next/static/x"}</script>');
    // Attributes stay, but a file must not turn async.
    expect(html).toMatch(/<script id="_R_" src="\/_next\/lite\/[0-9a-f]{20}\.js"><\/script>/);
    expect(html).toMatch(/<\/div><script id="_R_"[^>]*><\/script><script src="\/_next\/lite\/[0-9a-f]{20}\.js"><\/script>/);
    // The files are ASCII, whatever charset a browser decodes them with.
    for (const content of Object.values(files)) expect(content).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('push the same RSC payload the inline scripts did, under any mount and build', () => {
    const { html, files } = moveShellScriptsToFiles(SHELL, { buildId: 'b 1' }) as { html: string; files: Record<string, string> };
    for (const mount of ['/webmail', '/bulwark', '']) {
      const before = runScripts(rewriteShellForMount(SHELL, mount, 'b 1', ''), {}, mount);
      const after = runScripts(rewriteShellForMount(html, mount, 'b 1', ''), files, mount);
      expect(after.pushed, mount).toEqual(before.pushed);
      expect(after.ran, mount).toEqual(before.ran);
    }
    const pushed = runScripts(rewriteShellForMount(html, '/webmail', 'b 1', ''), files, '/webmail').pushed as unknown[][];
    expect(String(pushed[1][1])).toContain('"/webmail/_next/static/chunks/d.js"');
    expect(String(pushed[1][1])).toContain('"i":"/webmail/branding/i.svg"');
    expect(String(pushed[1][1])).toContain('<b> Grüße');
    expect(pushed[2]).toEqual([1, '/webmail/_next/static/chunks/e.js']);
    expect(pushed[3]).toEqual([1, '3:"/webmail/manifest.json?v=b%201']);
  });

  it('refuse a script with a root-absolute URL they cannot point at the mount', () => {
    expect(() => moveShellScriptsToFiles('<head></head><script>fetch("/_next/static/x.js")</script>', { buildId: 'b' })).toThrow(/cannot point at the mount/);
    expect(() => moveShellScriptsToFiles('<script>self.__next_f.push([1,"a\\x41\\"/_next/x"])</script>', { buildId: 'b' })).toThrow(/cannot point at the mount/);
  });
});

/** Runs the entry's script against a fake page served at `pathname` under `prefix`; returns what it writes. */
async function bootEntry(prefix: string, clientId: string, shellHtml: string) {
  const entry = stalwartRewriteIndex(buildStalwartEntry({ locales: ['en'], shells: ['', 'mail'], buildId: 'b<1>' }), prefix.slice(1), clientId);
  const script = entry.slice(entry.indexOf('<script>') + 8, entry.lastIndexOf('</script>'));
  const written: string[] = [];
  const fetched: string[] = [];
  const origin = 'https://mail.example.com';
  const win: Record<string, unknown> = {
    fetch: async (url: string) => {
      fetched.push(url);
      return new Response(shellHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    location: { origin },
  };
  const meta = { getAttribute: () => /<meta name="oauth-client-id" content="([^"]*)"/.exec(entry)![1].replace(/&quot;/g, '"') };
  const document = {
    baseURI: `${origin}${prefix}/`,
    documentElement: {},
    readyState: 'complete',
    querySelector: () => meta,
    getElementById: () => null,
    open: () => {},
    write: (html: string) => written.push(html),
    close: () => {},
  };
  const location = { origin, pathname: `${prefix}/en/mail/`, search: '', hash: '' };
  win.top = win;
  win.self = win;
  new Function('window', 'document', 'location', 'history', 'navigator', 'localStorage', 'fetch', script)(
    win, document, location, { state: null, replaceState: () => {} }, { languages: ['en'] }, { getItem: () => null },
    (url: string, init: unknown) => (win.fetch as (u: string, i: unknown) => Promise<Response>)(url, init),
  );
  await vi.waitFor(() => expect(written).toHaveLength(1));
  return { page: written[0], fetched, win };
}

describe('the entry writing a shell in', () => {
  it('puts the boot script first, as a file that carries the mount and client id', async () => {
    const shell = moveShellScriptsToFiles(SHELL, { buildId: 'b<1>' }).html;
    const { page, fetched } = await bootEntry('/webmail', 'my"client', shell);
    expect(fetched).toEqual(['/webmail/en/mail/index.html?v=b%3C1%3E']);
    expect(page).toMatch(/^<!DOCTYPE html><html lang="en"><head><script src="\/webmail\/_next\/lite\/boot\.js\?v=b%3C1%3E" data-mount="\/webmail" data-client-id="my&quot;client" data-build="b&lt;1&gt;"><\/script><meta charSet="utf-8"\/>/);
    // Nothing in the written page needs an inline script.
    expect(inlineScriptHashes(page)).toEqual([]);
    expect(page).not.toMatch(/"\/_next\//);
  });

  it('works at another mount with no client id', async () => {
    const shell = moveShellScriptsToFiles(SHELL, { buildId: 'b<1>' }).html;
    const { page } = await bootEntry('/bulwark', '', shell);
    expect(page).toContain('<script src="/bulwark/_next/lite/boot.js?v=b%3C1%3E" data-mount="/bulwark" data-client-id="" data-build="b&lt;1&gt;"></script>');
    expect(page).toMatch(/<script src="\/bulwark\/_next\/lite\/[0-9a-f]{20}\.js"><\/script>/);
  });
});

describe('the boot script', () => {
  it('sets the globals and the fetch shim from its own attributes', async () => {
    const attrs: Record<string, string> = { 'data-mount': '/webmail', 'data-client-id': 'cid', 'data-build': 'b1' };
    const fetchMock = vi.fn(async () => {
      const res = new Response('0:"/_next/x"\n', { headers: { 'content-type': 'application/octet-stream' } });
      Object.defineProperty(res, 'url', { value: 'https://mail.example.com/webmail/en/mail/index.txt' });
      return res;
    });
    const win: Record<string, unknown> = { fetch: fetchMock, location: { origin: 'https://mail.example.com' } };
    new Function('window', 'document', buildStalwartBootScript())(win, { currentScript: { getAttribute: (name: string) => attrs[name] ?? null } });
    expect(win.__BULWARK_LITE_MOUNT__).toBe('/webmail');
    expect(win.__BULWARK_LITE_OAUTH_CLIENT_ID__).toBe('cid');
    expect(win.TURBOPACK_CHUNK_BASE_PATH).toBe('/webmail/_next/');
    const res = await (win.fetch as (u: string) => Promise<Response>)('https://mail.example.com/webmail/en/mail/index.txt');
    expect(await res.text()).toBe('0:"/webmail/_next/x"\n');
  });
});

describe('postbuild and verify for the Stalwart target', () => {
  it('move every page script into a file and refuse a page that keeps one', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-csp-'));
    try {
      writeFileSync(join(root, 'VERSION'), '1.10.0\n');
      const out = join(root, 'out');
      for (const locale of ['en', 'de']) {
        for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
          mkdirSync(join(out, locale, surface), { recursive: true });
          writeFileSync(join(out, locale, surface, 'index.html'), SHELL);
        }
        writeFileSync(join(out, locale, 'index.html'), SHELL);
      }
      mkdirSync(join(out, 'connector', 'app'), { recursive: true });
      writeFileSync(join(out, 'connector', 'app', 'index.html'), SHELL);
      mkdirSync(join(out, '_next', 'static', 'chunks'), { recursive: true });
      mkdirSync(join(out, 'branding'), { recursive: true });

      runPostbuild({ root, env: { LITE_TARGET: 'stalwart', NEXT_PUBLIC_LITE_BUILD_ID: 'bid' } as unknown as NodeJS.ProcessEnv, log: () => {} });
      expect(existsSync(join(out, ...STALWART_BOOT_FILE.split('/')))).toBe(true);
      for (const page of ['en/mail/index.html', 'de/login/index.html', 'en/index.html', 'connector/app/index.html']) {
        const html = readFileSync(join(out, ...page.split('/')), 'utf8');
        expect(stalwartShellProblems(html), page).toEqual([]);
      }
      expect(verifyExport({ root }).problems).toEqual([]);

      writeFileSync(join(out, 'en', 'mail', 'index.html'), SHELL);
      rmSync(join(out, ...STALWART_BOOT_FILE.split('/')));
      const problems = verifyExport({ root }).problems.join('\n');
      expect(problems).toMatch(/out\/en\/mail\/index\.html carries no script policy/);
      expect(problems).toMatch(/out\/en\/mail\/index\.html has inline scripts/);
      expect(problems).toMatch(/missing out\/_next\/lite\/boot\.js/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
