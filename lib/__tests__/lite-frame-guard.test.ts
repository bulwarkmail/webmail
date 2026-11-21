// A <meta> policy can't carry frame-ancestors, and hosts such as GitHub Pages
// or a plain S3 bucket send no headers: every page of the static target
// refuses to run inside another site's frame itself, with a script that runs
// first and that the page's own policy allows.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_FRAME_MESSAGE,
  FRAME_GUARD_ATTRIBUTE,
  buildFrameGuardScript,
  buildReadme,
  buildStalwartEntry,
  frameGuardProblems,
  isForeignFrame,
  parentOriginOf,
} from '../../scripts/lite/lib.mjs';
import { runPostbuild } from '../../scripts/lite/postbuild.mjs';
import { verifyExport } from '../../scripts/lite/verify.mjs';

const SHELL = [
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>',
  '<link rel="stylesheet" href="/_next/static/chunks/a.css"/>',
  '<script src="/_next/static/chunks/b.js" async=""></script>',
  '<script>(function(){document.documentElement.dataset.boot="1"})();</script>',
  '</head><body><div>app</div><script>self.__next_f.push([1,"x"])</script></body></html>',
].join('');

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '_next') htmlFiles(path, out);
    } else if (name.endsWith('.html')) out.push(path);
  }
  return out;
}

describe('the pages of a static Lite export', () => {
  it('each start with the frame refusal, allowed by their own policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-frame-'));
    try {
      writeFileSync(join(root, 'VERSION'), '1.10.0\n');
      const out = join(root, 'out');
      for (const locale of ['en', 'de']) {
        for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login', 'auth/callback']) {
          mkdirSync(join(out, locale, ...surface.split('/')), { recursive: true });
          writeFileSync(join(out, locale, ...surface.split('/'), 'index.html'), SHELL);
        }
        writeFileSync(join(out, locale, 'index.html'), SHELL);
      }
      mkdirSync(join(out, 'connector', 'app'), { recursive: true });
      writeFileSync(join(out, 'connector', 'app', 'index.html'), SHELL);
      mkdirSync(join(out, '_next', 'static', 'chunks'), { recursive: true });
      mkdirSync(join(out, 'branding'), { recursive: true });
      writeFileSync(join(out, '404.html'), '<html></html>');

      runPostbuild({ root, env: {} as unknown as NodeJS.ProcessEnv, log: () => {} });

      const pages = htmlFiles(out);
      // Shells, the SSO return, the connector page, the root redirect and the 404 shim.
      expect(pages.length).toBe(19);
      for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        expect(frameGuardProblems(html), page).toEqual([]);
        // Before anything else the page runs, and after the policy that allows it.
        const firstScript = html.indexOf('<script');
        expect(html.slice(firstScript, firstScript + 40), page).toContain(FRAME_GUARD_ATTRIBUTE);
        expect(html.indexOf('<meta http-equiv="Content-Security-Policy"'), page).toBeLessThan(firstScript);
      }
      expect(verifyExport({ root }).problems).toEqual([]);

      // A page without it fails verification.
      writeFileSync(join(out, 'en', 'mail', 'index.html'), SHELL.replace('<meta charSet="utf-8"/>', '<meta charSet="utf-8"/><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"/>'));
      expect(verifyExport({ root }).problems.join('\n')).toMatch(/out\/en\/mail\/index\.html does not start with the frame refusal script/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('let the portal a build names frame them', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-frame-'));
    try {
      const out = join(root, 'out');
      for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
        mkdirSync(join(out, 'en', surface), { recursive: true });
        writeFileSync(join(out, 'en', surface, 'index.html'), SHELL);
      }
      runPostbuild({ root, env: { NEXT_PUBLIC_PARENT_ORIGIN: 'https://portal.example.com/app/' } as unknown as NodeJS.ProcessEnv, log: () => {} });
      expect(readFileSync(join(out, 'en', 'mail', 'index.html'), 'utf8')).toContain('"https://portal.example.com"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(parentOriginOf('https://portal.example.com/app/')).toBe('https://portal.example.com');
    expect(parentOriginOf('')).toBe('');
    expect(parentOriginOf('not a url')).toBe('');
  });
});

const ORIGIN = 'https://lite.example.com';

/** A frame on `origin`; another origin's location can't be read. */
function frame(origin: string, parent?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const win: Record<string, unknown> = { ...extra };
  const location = { origin, ...(extra.location as object) };
  Object.defineProperty(win, 'location', {
    get() {
      if (origin !== ORIGIN) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      return location;
    },
  });
  win.parent = parent ?? win;
  return win;
}

describe('the frame check', () => {
  it('lets a page load on its own and inside frames of its own origin', () => {
    expect(isForeignFrame(frame(ORIGIN), '')).toBe(false);
    expect(isForeignFrame(frame(ORIGIN, frame(ORIGIN)), '')).toBe(false);
    expect(isForeignFrame(frame(ORIGIN, frame(ORIGIN, frame(ORIGIN))), '')).toBe(false);
  });

  it('refuses another site anywhere above it, the top or a frame in between', () => {
    expect(isForeignFrame(frame(ORIGIN, frame('https://evil.example')), '')).toBe(true);
    expect(isForeignFrame(frame(ORIGIN, frame(ORIGIN, frame('https://evil.example'))), '')).toBe(true);
    // Own origin outside, another site in the middle.
    expect(isForeignFrame(frame(ORIGIN, frame('https://evil.example', frame(ORIGIN))), '')).toBe(true);
  });

  it('lets the named portal frame it, and nothing that frames the portal', () => {
    const portal = 'https://portal.example.com';
    const at = (ancestorOrigins: string[] | undefined, referrer = '') => frame(ORIGIN, frame(portal), {
      location: { ancestorOrigins }, document: { referrer },
    });
    expect(isForeignFrame(at([portal]), portal)).toBe(false);
    expect(isForeignFrame(at([portal, 'https://evil.example']), portal)).toBe(true);
    expect(isForeignFrame(at(['https://evil.example']), portal)).toBe(true);
    // Firefox has no ancestorOrigins: the page that loaded the frame decides.
    expect(isForeignFrame(at(undefined, `${portal}/inbox`), portal)).toBe(false);
    expect(isForeignFrame(at(undefined, 'https://evil.example/'), portal)).toBe(true);
    expect(isForeignFrame(at(undefined, ''), portal)).toBe(true);
    expect(isForeignFrame(at([portal]), '')).toBe(true);
  });
});

describe('the frame refusal', () => {
  /** A real document with the app in it, to run the refusal against. */
  function appDocument() {
    const doc = document.implementation.createHTMLDocument('Bulwark');
    doc.body.innerHTML = '<div id="app">app</div>';
    return doc;
  }

  it('stops the page and shows the message inside another site', () => {
    const win = frame(ORIGIN, frame('https://evil.example'));
    win.stop = vi.fn();
    const doc = appDocument();
    new Function('window', 'document', buildFrameGuardScript())(win, doc);
    expect(win.stop).toHaveBeenCalled();
    expect(doc.getElementById('app')).toBeNull();
    expect(doc.body.textContent).toBe(FOREIGN_FRAME_MESSAGE);
  });

  it('does nothing on its own origin', () => {
    const win = frame(ORIGIN, frame(ORIGIN));
    win.stop = vi.fn();
    const doc = appDocument();
    new Function('window', 'document', buildFrameGuardScript())(win, doc);
    expect(win.stop).not.toHaveBeenCalled();
    expect(doc.getElementById('app')).not.toBeNull();
  });

  it('holds no markup the build would mistake for the page head', () => {
    expect(buildFrameGuardScript({ parentOrigin: 'https://portal.example.com' })).not.toMatch(/<(head|html|meta)\b/i);
  });

  it('is the check the Stalwart entry uses too', () => {
    const entry = buildStalwartEntry({ locales: ['en'], shells: [''], buildId: 'b' });
    expect(entry).toContain(`var isForeignFrame = ${isForeignFrame.toString()}`);
    expect(entry).toMatch(/if \(isForeignFrame\(window, ""\)\) return fail\(/);
  });
});

describe('the static README', () => {
  it('no longer asks for unsafe-inline and names the hosts that send no headers', () => {
    const readme = buildReadme({ version: '1.10.0', commit: 'abc1234', basePath: '', locales: ['en'] });
    expect(readme).not.toMatch(/must allow\s+`'unsafe-inline'`/);
    expect(readme).toMatch(/GitHub Pages or a plain S3 bucket/);
    expect(readme).toMatch(/`frame-ancestors` and `X-Frame-Options`/);
    expect(readme).toMatch(/refuses to run inside another site's frame/);
  });
});
