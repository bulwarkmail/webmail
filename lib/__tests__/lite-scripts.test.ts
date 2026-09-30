import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LITE_API_STRING_ALLOWLIST,
  LITE_PENDING_PATH_KEY,
  LITE_TARGETS,
  LOCALE_STORAGE_KEY,
  STALWART_BASE_HREF_LITERAL,
  STALWART_CONTENT_TYPES,
  STALWART_DEFAULT_PREFIX,
  STALWART_ENTRY_MARKER,
  STALWART_OAUTH_META_LITERAL,
  STALWART_ZIP_NAME,
  buildCaddyExample,
  buildHeaders,
  buildLiteConfig,
  buildLitePolicy,
  buildManifest,
  buildNginxContainerTemplate,
  buildNginxExample,
  buildNotFoundShim,
  buildReadme,
  buildRedirects,
  buildRootRedirect,
  buildScriptHashCsp,
  buildStalwartEntry,
  buildStalwartEntryCsp,
  buildStalwartManifest,
  buildStalwartReadme,
  buildZip,
  collectApiStrings,
  collectZipEntries,
  discoverBuiltLocales,
  discoverShellDirs,
  emulateStalwartRequest,
  findSegmentPrefetchDirs,
  flightTextRowsWithNeedles,
  inlineJson,
  inlineScriptHashes,
  installStalwartFetchShim,
  isReservedStalwartSegment,
  listZipEntries,
  makeBuildId,
  normalizeBasePath,
  parseBool,
  parseLiteTarget,
  readZipEntry,
  resolveStalwartBoot,
  rewriteFlightForMount,
  rewriteShellForMount,
  stalwartContentType,
  stalwartEntryProblems,
  stalwartOauthMeta,
  stalwartPrefixProblems,
  stalwartRewriteIndex,
  stalwartZipEntryProblems,
  unexpectedApiStrings,
  withScriptHashCsp,
} from '../../scripts/lite/lib.mjs';
import { collectTestPaths, planRemovals, runPrepare } from '../../scripts/lite/prepare.mjs';
import { runPostbuild } from '../../scripts/lite/postbuild.mjs';
import { verifyExport } from '../../scripts/lite/verify.mjs';
import { stageContainer } from '../../scripts/lite/container.mjs';
import { LITE_PENDING_PATH_KEY as APP_LITE_PENDING_PATH_KEY } from '../lite';
import { applyLiteConfig } from '../lite-config';

/** The scripts take `process.env`-shaped input; tests pass plain objects. */
function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-'));
  const touch = (rel: string, content = '') => {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };
  touch('proxy.ts');
  touch('app/api/config/route.ts');
  touch('app/(main)/admin/page.tsx');
  touch('app/(main)/[locale]/mail/[[...segments]]/page.tsx');
  touch('lib/__tests__/foo.test.ts');
  touch('lib/keep.ts');
  touch('stores/bar.test.tsx');
  touch('scripts/lite/lib.mjs');
  touch('scripts/lite/smoke/lite.spec.ts');
  touch('node_modules/pkg/x.test.js');
  touch('repos/other/y.test.ts');
  touch('VERSION', '1.10.0\n');
  return root;
}

describe('lite build helpers', () => {
  it('parses booleans and base paths', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('no')).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
    expect(normalizeBasePath('/webmail/')).toBe('/webmail');
    expect(normalizeBasePath('')).toBe('');
    expect(() => normalizeBasePath('webmail')).toThrow(/start with/);
  });

  it('derives config.json from the LITE_* inputs with safe defaults', () => {
    const empty = buildLiteConfig({});
    expect(empty.jmapServerUrl).toBe('');
    expect(empty).not.toHaveProperty('allowCustomJmapEndpoint');
    expect(applyLiteConfig(empty).allowCustomJmapEndpoint).toBe(true);
    expect(empty.rememberMeEnabled).toBe(true);
    expect(empty.demoMode).toBe(false);
    expect(empty.appName).toBe('Bulwark Webmail');

    const fixed = buildLiteConfig({ LITE_JMAP_SERVER_URL: 'https://mail.example.com/', LITE_APP_NAME: 'Acme', LITE_DEMO_MODE: 'true', LITE_REMEMBER_ME: 'false' });
    expect(fixed.jmapServerUrl).toBe('https://mail.example.com');
    expect(fixed).not.toHaveProperty('allowCustomJmapEndpoint');
    expect(applyLiteConfig(fixed).allowCustomJmapEndpoint).toBe(false);
    expect(fixed.appName).toBe('Acme');
    expect(fixed.demoMode).toBe(true);
    expect(fixed.rememberMeEnabled).toBe(false);
    expect(buildLitePolicy().features).toEqual({ pluginsEnabled: false, sidebarAppsEnabled: false });
    expect(buildLiteConfig({ LITE_ALLOW_CUSTOM_ENDPOINT: 'true' }).allowCustomJmapEndpoint).toBe(true);
    expect(buildLiteConfig({ LITE_ALLOW_CUSTOM_ENDPOINT: 'false' }).allowCustomJmapEndpoint).toBe(false);
  });

  it('hides the server field once a deployer fills in jmapServerUrl of the shipped config.json (#1087)', () => {
    const shipped = buildLiteConfig({});
    const edited = { ...shipped, jmapServerUrl: 'https://mail.example.com' };
    expect(applyLiteConfig(edited).allowCustomJmapEndpoint).toBe(false);
  });

  it('prefixes manifest and redirect paths with the base path', () => {
    const manifest = buildManifest({ appName: 'Acme', basePath: '/webmail' });
    expect(manifest.start_url).toBe('/webmail/');
    expect(manifest.icons[0].src).toBe('/webmail/icon-192x192.png');

    const redirects = buildRedirects({ basePath: '/webmail', locales: ['en', 'de'] });
    expect(redirects).toContain('/webmail/en/mail/*  /webmail/en/mail/index.html  200');
    expect(redirects).toContain('/webmail/de/settings/*  /webmail/de/settings/index.html  200');
    expect(redirects).not.toContain('/en/login/*');
  });

  it('writes a root shim that knows every built locale and the fallback', () => {
    const html = buildRootRedirect({ basePath: '/webmail', locales: ['de', 'en', 'zh-TW'], defaultLocale: 'en' });
    expect(html).toContain('var locales = ["de","en","zh-TW"]');
    expect(html).toContain('var fallback = "en"');
    expect(html).toContain('var base = "/webmail"');
    expect(html).toContain('href="/webmail/en/"');
    // The language picked in Settings (zustand persist key of stores/locale-store.ts) wins.
    expect(html).toContain(`localStorage.getItem("${LOCALE_STORAGE_KEY}")`);
    expect(LOCALE_STORAGE_KEY).toBe('locale-storage');
    // An unknown default falls back to the first built locale.
    expect(buildRootRedirect({ locales: ['de'], defaultLocale: 'fr' })).toContain('var fallback = "de"');
  });

  it('emits a CSP that allows inline scripts and the configured server only', () => {
    const headers = buildHeaders({ basePath: '', connectSrc: 'https://mail.example.com' });
    expect(headers).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers).toContain("connect-src 'self' https://mail.example.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('/_next/static/*');
    expect(buildHeaders({ basePath: '/w', connectSrc: '*' })).toMatch(/^\/w\/\*/);
  });

  // The header policy has to allow inline scripts (the export ships hydration
  // scripts and one header cannot list every page's hashes); each page pins
  // its own inline scripts with a <meta> policy enforced alongside it.
  it('pins each page to its own inline scripts', () => {
    const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
    const html = [
      '<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>x</title>',
      '<script src="/_next/static/chunks/a.js" async=""></script>',
      '<script>self.__next_f.push([1,"a"])</script>',
      '<script type="application/json">{"not":"code"}</script>',
      '<script type="module">import("./m.js")</script>',
      '</head><body><script>\r\nwindow.x = 1;\r\n</script></body></html>',
    ].join('');

    expect(inlineScriptHashes(html)).toEqual([
      sha('self.__next_f.push([1,"a"])'),
      sha('import("./m.js")'),
      sha('\nwindow.x = 1;\n'),
    ]);

    const pinned = withScriptHashCsp(html);
    const meta = `<meta http-equiv="Content-Security-Policy" content="${buildScriptHashCsp(inlineScriptHashes(html))}"/>`;
    expect(pinned.indexOf(meta)).toBe(pinned.indexOf('<meta charSet="utf-8"/>') + '<meta charSet="utf-8"/>'.length);
    expect(pinned.indexOf(meta)).toBeLessThan(pinned.indexOf('<script'));
    expect(buildScriptHashCsp([])).toBe("script-src 'self'; object-src 'none'; base-uri 'self'");
    expect(withScriptHashCsp('<html><head><script>1</script></head></html>')).toMatch(/^<html><head><meta http-equiv/);
    expect(withScriptHashCsp('<html><script>1</script></html>')).toMatch(/^<html><meta http-equiv="Content-Security-Policy"[^>]*><script>/);
  });

  it('writes a 404 shim that parks deep links for known locale/surface pairs only', () => {
    const html = buildNotFoundShim({ basePath: '/webmail', locales: ['de', 'en'] });
    expect(html).toContain('var base = "/webmail"');
    expect(html).toContain('var locales = ["de","en"]');
    expect(html).toContain('var surfaces = ["mail","calendar","contacts","files","settings"]');
    expect(html).toContain(`sessionStorage.setItem("${LITE_PENDING_PATH_KEY}"`);
    // Only allowlisted segments are ever assembled into the redirect target.
    expect(html).toContain('var target = base + "/" + parts[0] + "/" + parts[1] + "/"');
    expect(html).toContain('location.replace(target)');
    expect(html).toContain('href="/webmail/"');
    // The key the shim writes is the one the app reads.
    expect(LITE_PENDING_PATH_KEY).toBe(APP_LITE_PENDING_PATH_KEY);
  });

  it('renders host snippets and the README for the built variant', () => {
    expect(buildNginxExample({ basePath: '' })).toContain('(?<surface>mail|calendar|contacts|files|settings)');
    // Root-relative everywhere: a sub-path mount means the files live in <root><basePath>
    // (alias does not work inside a regex location and produced a redirect cycle).
    const nginxSub = buildNginxExample({ basePath: '/w' });
    expect(nginxSub).not.toContain('alias ');
    expect(nginxSub).toContain('Unzip the archive into /var/www/bulwark-lite/w');
    expect(nginxSub).toContain('try_files $uri $uri/ $uri/index.html /w/$locale/$surface/index.html');
    expect(nginxSub).toContain('error_page 404 /w/404.html');
    expect(nginxSub).toContain('default_type application/manifest+json');
    expect(buildCaddyExample({ basePath: '' })).toContain('try_files {path} {path}/ {path}/index.html /{re.surface.1}/{re.surface.2}/index.html');
    expect(buildCaddyExample({ basePath: '/w' })).toContain('rewrite @notfound /w/404.html');
    // The examples send the same policy as _headers, for the configured server.
    const nginxCsp = buildNginxExample({ basePath: '', connectSrc: 'https://m.example' });
    expect(nginxCsp.match(/add_header Content-Security-Policy "[^"]*connect-src 'self' https:\/\/m\.example[^"]*" always;/g)).toHaveLength(2);
    expect(buildCaddyExample({ basePath: '', connectSrc: 'https://m.example' })).toMatch(/Content-Security-Policy "[^"]*connect-src 'self' https:\/\/m\.example/);
    expect(buildReadme({ version: '1.10.0', commit: 'abc1234', basePath: '/w', locales: ['en'] })).toContain('unzip into `<web root>/w`');
    const readme = buildReadme({ version: '1.10.0', commit: 'abc1234', basePath: '/w', locales: ['en'], jmapServerUrl: 'https://m.example', demoMode: true });
    expect(readme).toContain('# Bulwark Lite 1.10.0 (abc1234)');
    expect(readme).toContain('Demo mode is ON');
    expect(readme).toContain('permissive-cors = true');
    expect(readme).toContain('currently `https://m.example`');
  });

  it('renders the container nginx template with every header in every header-bearing location', () => {
    const conf = buildNginxContainerTemplate();
    expect(conf).toContain('listen 8080;');
    // Filled in by the image: the IPv6 listen line and the CSP's connect-src.
    expect(conf).toContain('\n    ${LITE_LISTEN_IPV6}\n');
    expect(conf).toContain("connect-src 'self' ${LITE_CSP_CONNECT_SRC}; frame-src");
    // Every other $ belongs to nginx; the image limits envsubst to LITE_*.
    expect([...conf.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]).filter((name) => !name.startsWith('LITE_'))).toEqual([]);
    expect(conf).toContain('try_files $uri $uri/ $uri/index.html /$locale/$surface/index.html;');
    expect(conf).toContain('(?<surface>mail|calendar|contacts|files|settings)');
    expect(conf).toContain('error_page 404 /404.html;');
    expect(conf).toContain('absolute_redirect off;');
    // add_header in a location drops the inherited set: server, /_next/static/ and /connector.json each carry it.
    expect(conf.match(/add_header Content-Security-Policy /g)).toHaveLength(3);
    expect(conf.match(/add_header X-Content-Type-Options nosniff always;/g)).toHaveLength(3);
    // The CSP is one double-quoted nginx string.
    expect(conf).not.toMatch(/Content-Security-Policy "[^"\n]*"[^;\n]*"/);
  });

  it('flags server endpoints outside the documented allowlist', () => {
    expect(unexpectedApiStrings(['/api/config', '/api/plugins/x', '/api/push/register/web'])).toEqual([]);
    expect(unexpectedApiStrings(['/api/brand-new-thing', '/api/config'])).toEqual(['/api/brand-new-thing']);
    expect(LITE_API_STRING_ALLOWLIST).toContain('/api/config');
  });
});

describe('prepare / postbuild / verify against a fake checkout', () => {
  it('plans the server-only trees and every test file, skipping node_modules, repos and scripts', () => {
    const root = makeRepo();
    try {
      const tests = collectTestPaths(root).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
      expect(tests.sort()).toEqual(['lib/__tests__', 'stores/bar.test.tsx']);
      const plan = planRemovals(root).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
      expect(plan).toContain('proxy.ts');
      expect(plan).toContain('app/api');
      expect(plan).toContain('app/(main)/admin');
      expect(plan).not.toContain('app/(main)/[locale]/mail/[[...segments]]/page.tsx');
      expect(plan).not.toContain('scripts/lite/smoke/lite.spec.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to delete outside CI unless --in-place is given, and --dry-run never deletes', () => {
    const root = makeRepo();
    try {
      const log = () => {};
      expect(() => runPrepare({ root, argv: [], env: env(), log })).toThrow(/refusing/);
      runPrepare({ root, argv: ['--dry-run'], env: env(), log });
      expect(existsSync(join(root, 'proxy.ts'))).toBe(true);

      const result = runPrepare({ root, argv: ['--in-place'], env: env(), log });
      expect(result.removed.length).toBeGreaterThan(0);
      expect(existsSync(join(root, 'proxy.ts'))).toBe(false);
      expect(existsSync(join(root, 'app', 'api'))).toBe(false);
      expect(existsSync(join(root, 'lib', '__tests__'))).toBe(false);
      expect(existsSync(join(root, 'lib', 'keep.ts'))).toBe(true);
      expect(existsSync(join(root, 'scripts', 'lite', 'smoke', 'lite.spec.ts'))).toBe(true);
      expect(existsSync(join(root, 'node_modules', 'pkg', 'x.test.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CI=true counts as consent', () => {
    const root = makeRepo();
    try {
      runPrepare({ root, argv: [], env: env({ CI: 'true' }), log: () => {} });
      expect(existsSync(join(root, 'proxy.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('postbuild writes the deployer files for the built locales and verify accepts the result', () => {
    const root = makeRepo();
    try {
      const out = join(root, 'out');
      for (const locale of ['en', 'de']) {
        for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
          mkdirSync(join(out, locale, surface), { recursive: true });
          writeFileSync(join(out, locale, surface, 'index.html'), '<html></html>');
        }
        writeFileSync(join(out, locale, 'index.html'), '<html></html>');
      }
      mkdirSync(join(out, '_next', 'static', 'chunks'), { recursive: true });
      writeFileSync(join(out, '_next', 'static', 'chunks', 'app.js'), 'fetch("/api/config");fetch(`/api/plugins`);');
      mkdirSync(join(out, 'branding'), { recursive: true });
      writeFileSync(join(out, '404.html'), '<html></html>');

      expect(discoverBuiltLocales(out)).toEqual(['de', 'en']);

      const result = runPostbuild({
        root,
        env: env({ LITE_JMAP_SERVER_URL: 'https://mail.example.com', LITE_APP_NAME: 'Acme', NEXT_PUBLIC_BASE_PATH: '/w', GIT_COMMIT: 'abcdef1234567' }),
        log: () => {},
      });
      expect(result.locales).toEqual(['de', 'en']);
      expect(result.basePath).toBe('/w');
      for (const file of ['config.json', 'policy.json', 'manifest.webmanifest', 'index.html', '_redirects', '_headers', 'nginx.conf.example', 'Caddyfile.example', 'LITE-README.md', 'lite-build.json']) {
        expect(existsSync(join(out, file)), file).toBe(true);
      }
      expect(collectApiStrings(join(out, '_next', 'static'))).toEqual(['/api/config', '/api/plugins']);
      // Next's default not-found page was replaced by the park-and-replay shim.
      expect(readFileSync(join(out, '404.html'), 'utf8')).toContain(LITE_PENDING_PATH_KEY);

      const verdict = verifyExport({ root });
      expect(verdict.problems).toEqual([]);
      expect(verdict.locales).toEqual(['de', 'en']);

      // An export whose 404.html is still Next's default fails verification.
      writeFileSync(join(out, '404.html'), '<html>404: This page could not be found.</html>');
      expect(verifyExport({ root }).problems.join('\n')).toContain('404.html is not the Lite shim');
      writeFileSync(join(out, '404.html'), buildNotFoundShim({ basePath: '/w', locales: ['de', 'en'] }));

      // A new, undocumented endpoint in a chunk is a verification failure.
      writeFileSync(join(out, '_next', 'static', 'chunks', 'new.js'), 'apiFetch("/api/brand-new")');
      expect(verifyExport({ root }).problems.join('\n')).toContain('/api/brand-new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stages the container image content from a root-mounted static export only', () => {
    const root = makeRepo();
    try {
      const out = join(root, 'out');
      for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
        mkdirSync(join(out, 'en', surface), { recursive: true });
        writeFileSync(join(out, 'en', surface, 'index.html'), '<html></html>');
      }
      expect(() => stageContainer({ root, log: () => {} })).toThrow(/run `npm run build:lite` first/);

      runPostbuild({ root, env: env({ NEXT_PUBLIC_BASE_PATH: '/w' }), log: () => {} });
      expect(() => stageContainer({ root, log: () => {} })).toThrow(/serves from \/, out\/ was built with NEXT_PUBLIC_BASE_PATH=\/w/);

      runPostbuild({ root, env: env({}), log: () => {} });
      const dest = join(root, 'image');
      // A stale file from an earlier staging must not survive.
      mkdirSync(join(dest, 'html'), { recursive: true });
      writeFileSync(join(dest, 'html', 'stale.txt'), '');
      stageContainer({ root, dest, log: () => {} });
      expect(readFileSync(join(dest, 'default.conf.template'), 'utf8')).toBe(buildNginxContainerTemplate());
      for (const file of ['config.json', 'policy.json', 'connector.json', '404.html', 'lite-build.json', 'en/mail/index.html']) {
        expect(existsSync(join(dest, 'html', ...file.split('/'))), file).toBe(true);
      }
      for (const file of ['_redirects', '_headers', 'nginx.conf.example', 'Caddyfile.example', 'LITE-README.md', 'stale.txt']) {
        expect(existsSync(join(dest, 'html', file)), file).toBe(false);
      }
      // out/ itself is left alone: the zip is packed from it.
      expect(existsSync(join(out, '_headers'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('verify lists what is missing from an incomplete export', () => {
    const root = makeRepo();
    try {
      mkdirSync(join(root, 'out'), { recursive: true });
      const { problems } = verifyExport({ root });
      expect(problems).toContain('no locale shells found (out/<locale>/mail/index.html)');
      expect(problems).toContain('missing out/config.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stalwart Application target
// ---------------------------------------------------------------------------

function entriesOf(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
}

describe('Stalwart target: routing rules and constants', () => {
  it('parses the build target from argv and env', () => {
    expect(parseLiteTarget([], {})).toBe('static');
    expect(parseLiteTarget(['--target=stalwart'], {})).toBe('stalwart');
    expect(parseLiteTarget(['--target', 'Stalwart'], {})).toBe('stalwart');
    expect(parseLiteTarget([], { LITE_TARGET: 'stalwart' })).toBe('stalwart');
    expect(parseLiteTarget(['--target=static'], { LITE_TARGET: 'stalwart' })).toBe('static');
    expect(() => parseLiteTarget(['--target=netlify'], {})).toThrow(/unknown Lite target/);
    expect(LITE_TARGETS).toEqual(['static', 'stalwart']);
  });

  it('knows which first segments Stalwart keeps for itself', () => {
    for (const s of ['jmap', 'api', 'auth', 'dav', '.well-known', 'login', 'device', 'metrics', 'admin', 'account', 'mail', 'calendar', 'AutoDiscover']) {
      expect(isReservedStalwartSegment(s), s).toBe(true);
    }
    for (const s of ['webmail', 'bulwark', 'en', '_next', 'index.html']) expect(isReservedStalwartSegment(s), s).toBe(false);
    expect(stalwartPrefixProblems(STALWART_DEFAULT_PREFIX)).toEqual([]);
    expect(stalwartPrefixProblems('/bulwark/')).toEqual([]);
    expect(stalwartPrefixProblems('/mail')[0]).toMatch(/routed by Stalwart/);
    expect(stalwartPrefixProblems('/apps/webmail')[0]).toMatch(/first segment only/);
    expect(stalwartPrefixProblems('/')[0]).toMatch(/empty/);
    expect(stalwartPrefixProblems('/we b')[0]).toMatch(/characters/);
  });

  it('maps extensions exactly like application.rs', () => {
    expect(stalwartContentType('index.html')).toBe('text/html');
    expect(stalwartContentType('_next/static/chunks/a.js')).toBe('application/javascript');
    expect(stalwartContentType('config.json')).toBe('application/json');
    expect(stalwartContentType('icon.png')).toBe('image/png');
    for (const name of ['en/mail/index.txt', 'a.woff2', 'manifest.webmanifest', 'x.mjs', 'x.mp3', 'x.webp', 'LICENSE']) {
      expect(stalwartContentType(name), name).toBe('application/octet-stream');
    }
    expect(Object.keys(STALWART_CONTENT_TYPES).sort()).toEqual(['css', 'html', 'ico', 'js', 'json', 'png', 'svg', 'wasm']);
  });

  it('makes build ids that differ per commit and build time', () => {
    const id = makeBuildId({ version: '1.10.0', commit: 'abcdef1234', now: 1_700_000_000_000 });
    expect(id).toBe(`1.10.0-abcdef1-${(1_700_000_000).toString(36)}`);
    expect(makeBuildId({ version: '1.10.0', commit: 'abcdef1234', now: 1_700_000_001_000 })).not.toBe(id);
    expect(makeBuildId({ version: '1 0"<', commit: '' })).toMatch(/^10-local-/);
  });
});

describe('Stalwart target: entry document logic (runs in the browser)', () => {
  const locales = ['de', 'en', 'zh-TW'];
  const shells = ['', 'auth/callback', 'calendar', 'contacts', 'files', 'login', 'mail', 'plugins/oauth/callback', 'pro', 'settings'];

  it('boots the shell that owns the path and keeps the address', () => {
    expect(resolveStalwartBoot('/webmail/en/mail/thread/abc', '/webmail', locales, shells, 'de')).toEqual({ locale: 'en', shell: 'en/mail/index.html', canonical: null });
    expect(resolveStalwartBoot('/webmail/de/calendar/week/2026-09-17', '/webmail', locales, shells, 'en')).toEqual({ locale: 'de', shell: 'de/calendar/index.html', canonical: null });
    expect(resolveStalwartBoot('/webmail/zh-TW/settings/', '/webmail', locales, shells, 'en')?.shell).toBe('zh-TW/settings/index.html');
    expect(resolveStalwartBoot('/webmail/en/auth/callback', '/webmail', locales, shells, 'en')?.shell).toBe('en/auth/callback/index.html');
    expect(resolveStalwartBoot('/webmail/en/', '/webmail', locales, shells, 'de')).toEqual({ locale: 'en', shell: 'en/index.html', canonical: null });
    expect(resolveStalwartBoot('/webmail/en', '/webmail', locales, shells, 'de')?.shell).toBe('en/index.html');
  });

  it('sends locale-less and unknown paths to the preferred (or linked) locale root', () => {
    expect(resolveStalwartBoot('/webmail/', '/webmail', locales, shells, 'de')).toEqual({ locale: 'de', shell: 'de/index.html', canonical: '/webmail/de/' });
    expect(resolveStalwartBoot('/webmail', '/webmail', locales, shells, 'en')?.canonical).toBe('/webmail/en/');
    expect(resolveStalwartBoot('/webmail/nope/x', '/webmail', locales, shells, 'en')).toEqual({ locale: 'en', shell: 'en/index.html', canonical: '/webmail/en/' });
    expect(resolveStalwartBoot('/webmail/en/nope', '/webmail', locales, shells, 'de')).toEqual({ locale: 'en', shell: 'en/index.html', canonical: '/webmail/en/' });
    // `auth` alone is not the auth/callback shell.
    expect(resolveStalwartBoot('/webmail/en/auth', '/webmail', locales, shells, 'de')?.canonical).toBe('/webmail/en/');
  });

  it('boots the callback for the locale-free OAuth redirect URI', () => {
    expect(resolveStalwartBoot('/webmail/oauth/callback', '/webmail', locales, shells, 'de')).toEqual({ locale: 'de', shell: 'de/auth/callback/index.html', canonical: '/webmail/de/auth/callback/' });
    expect(resolveStalwartBoot('/webmail/oauth/callback/', '/webmail', locales, shells, 'en')?.shell).toBe('en/auth/callback/index.html');
    expect(resolveStalwartBoot('/oauth/callback', '', locales, shells, 'en')?.canonical).toBe('/en/auth/callback/');
    // Nothing else below `oauth`, and not in a bundle without the callback shell.
    expect(resolveStalwartBoot('/webmail/oauth', '/webmail', locales, shells, 'en')?.shell).toBe('en/index.html');
    expect(resolveStalwartBoot('/webmail/oauth/callback/x', '/webmail', locales, shells, 'en')?.shell).toBe('en/index.html');
    expect(resolveStalwartBoot('/webmail/oauth/callback', '/webmail', locales, shells.filter((s: string) => s !== 'auth/callback'), 'en')?.shell).toBe('en/index.html');
  });

  it('works at the site root and refuses paths outside the mount', () => {
    expect(resolveStalwartBoot('/en/mail', '', locales, shells, 'de')?.shell).toBe('en/mail/index.html');
    expect(resolveStalwartBoot('/', '', locales, shells, 'de')?.canonical).toBe('/de/');
    expect(resolveStalwartBoot('/other/en/mail', '/webmail', locales, shells, 'en')).toBeNull();
    expect(resolveStalwartBoot('/webmailer/en/mail', '/webmail', locales, shells, 'en')).toBeNull();
  });

  it('points a prerendered shell at the mount, in markup and in the inline RSC payload', () => {
    const shell = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/chunks/a.css"/>'
      + '<link rel="manifest" href="/manifest.webmanifest"/><link rel="icon" href="/branding/Bulwark_Favicon.svg"/>'
      + '<script src="/_next/static/chunks/b.js" async=""></script></head><body>'
      + '<script>self.__next_f.push([1,"2:I[1,[\\"/_next/static/chunks/c.js\\"],\\"default\\"]\\n"])</script></body></html>';
    const out = rewriteShellForMount(shell, '/webmail', 'b 1', '<script>BOOT</script>');
    expect(out).toContain('<head><script>BOOT</script><link');
    expect(out).toContain('href="/webmail/_next/static/chunks/a.css"');
    expect(out).toContain('src="/webmail/_next/static/chunks/b.js"');
    expect(out).toContain('\\"/webmail/_next/static/chunks/c.js\\"');
    expect(out).toContain('href="/webmail/manifest.json?v=b%201"');
    expect(out).toContain('href="/webmail/branding/Bulwark_Favicon.svg"');
    expect(out).not.toMatch(/"\/_next\//);
    // At the site root nothing moves, the boot script still goes in.
    expect(rewriteShellForMount('<head></head>', '', 'b', 'X')).toBe('<head>X</head>');
  });

  it('rewrites RSC payload rows but copies length-prefixed text rows byte-exactly', () => {
    const text = 'ü€'; // 2 + 3 UTF-8 bytes
    const tRow = `9:T${Buffer.byteLength(`${text}"/_next/x`).toString(16)},${text}"/_next/x`;
    const payload = `0:["$","link",null,{"href":"/_next/static/chunks/a.css"}]\n${tRow}1:I[5,["/_next/static/chunks/b.js"],"x"]\n2:{"m":"/manifest.webmanifest","i":"/branding/i.svg"}\n`;
    const out = rewriteFlightForMount(payload, '/webmail', 'id');
    expect(out).toContain('{"href":"/webmail/_next/static/chunks/a.css"}');
    expect(out).toContain(`${tRow}1:I[5,["/webmail/_next/static/chunks/b.js"],"x"]`);
    expect(out).toContain('"m":"/webmail/manifest.json?v=id","i":"/webmail/branding/i.svg"');
    // A surrogate pair counts as four bytes.
    const emoji = '😀ab';
    const row = `3:T${Buffer.byteLength(emoji).toString(16)},${emoji}`;
    expect(rewriteFlightForMount(`${row}4:"/_next/y"\n`, '/w', 'b')).toBe(`${row}4:"/w/_next/y"\n`);
    // Malformed text rows cannot loop forever.
    expect(rewriteFlightForMount('5:Tzz,"/_next/"', '/w', 'b')).toBe('5:Tzz,"/_next/"');
    expect(rewriteFlightForMount('', '/w', 'b')).toBe('');
  });

  it('finds text rows that would escape the rewrite', () => {
    expect(flightTextRowsWithNeedles('0:"x"\n1:T3,abc2:"/_next/ok"\n')).toEqual([]);
    const body = 'see "/_next/static/x"';
    expect(flightTextRowsWithNeedles(`a:T${Buffer.byteLength(body).toString(16)},${body}`)).toEqual(['a']);
  });

  it('relabels and rewrites RSC payloads fetched below the mount, and nothing else', async () => {
    const origin = 'https://mail.example.com';
    const responses: Record<string, [string, string]> = {
      [`${origin}/webmail/en/mail/index.txt`]: ['application/octet-stream', '0:I[1,["/_next/static/chunks/a.js"],"x"]\n'],
      [`${origin}/webmail/en/cal/index.txt`]: ['text/plain', '0:"/_next/b.js"\n'],
      [`${origin}/webmail/en/x.txt`]: ['text/html', '<html>entry</html>'],
      [`${origin}/other/y.txt`]: ['application/octet-stream', '"/_next/z"'],
      [`${origin}/webmail/font.woff2`]: ['application/octet-stream', 'bin'],
    };
    const win = {
      location: { origin },
      fetch: async (url: string) => {
        const [type, body] = responses[url];
        const res = new Response(body, { status: 200, headers: { 'content-type': type } });
        Object.defineProperty(res, 'url', { value: url });
        return res;
      },
    } as unknown as Window & { fetch: (u: string) => Promise<Response> };
    installStalwartFetchShim(win, '/webmail', 'b', rewriteFlightForMount);
    installStalwartFetchShim(win, '/webmail', 'b', rewriteFlightForMount); // idempotent

    const rsc = await win.fetch(`${origin}/webmail/en/mail/index.txt`);
    expect(rsc.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(rsc.url).toBe(`${origin}/webmail/en/mail/index.txt`);
    expect(await rsc.text()).toBe('0:I[1,["/webmail/_next/static/chunks/a.js"],"x"]\n');
    expect(await (await win.fetch(`${origin}/webmail/en/cal/index.txt`)).text()).toBe('0:"/webmail/_next/b.js"\n');
    const html = await win.fetch(`${origin}/webmail/en/x.txt`);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(await (await win.fetch(`${origin}/other/y.txt`)).text()).toBe('"/_next/z"');
    expect((await win.fetch(`${origin}/webmail/font.woff2`)).headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serialises values for inline scripts without a </script> breakout', () => {
    expect(inlineJson(['</script>', 'a\u2028b'])).toBe('["\\u003c/script>","a\\u2028b"]');
  });
});

describe('Stalwart target: the entry document', () => {
  const html = buildStalwartEntry({ locales: ['de', 'en'], shells: ['', 'mail', 'calendar'], defaultLocale: 'en', buildId: '1.10.0-abc-x', appName: 'Acme <Mail>' });

  it('carries both literals Stalwart rewrites exactly once and nothing root-absolute', () => {
    expect(html.split(STALWART_BASE_HREF_LITERAL)).toHaveLength(2);
    expect(html.split(STALWART_OAUTH_META_LITERAL)).toHaveLength(2);
    expect(html).toContain(STALWART_ENTRY_MARKER);
    expect(html).toContain('<title>Acme &lt;Mail&gt;</title>');
    expect(stalwartEntryProblems(html)).toEqual([]);
    // The inline script is valid JavaScript.
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('var BUILD_ID = "1.10.0-abc-x"');
  });

  // Stalwart sends no security headers for an Application: the entry carries
  // its own policy and refuses to run in another origin's frame.
  it('carries a CSP ahead of its script and refuses foreign frames', () => {
    const csp = buildStalwartEntryCsp();
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain('frame-ancestors'); // ignored in a <meta>
    const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
    expect(html.indexOf(meta)).toBeGreaterThan(-1);
    expect(html.indexOf(meta)).toBeLessThan(html.indexOf('<script>'));
    expect(html).toContain('window.top.location.origin !== location.origin');
    expect(html).toMatch(/if \(foreignFrame\) return fail\(/);
  });

  it('survives both Stalwart rewrites, including the pre-0.16.19 replace-all', () => {
    const current = stalwartRewriteIndex(html, 'webmail', 'my"client');
    expect(current).toContain('<base href="/webmail/" />');
    expect(current).toContain('<meta name="oauth-client-id" content="my&quot;client" />');
    const legacy = stalwartRewriteIndex(html, 'webmail', 'ignored', { legacy: true });
    expect(legacy).toContain('<base href="/webmail/" />');
    expect(legacy).toContain('<meta name="oauth-client-id" content="" />');
    expect(stalwartOauthMeta('a&b<c>')).toBe('<meta name="oauth-client-id" content="a&amp;b&lt;c&gt;"');
  });

  it('flags a broken entry', () => {
    expect(stalwartEntryProblems('<html></html>').join('\n')).toMatch(/exactly once[\s\S]*exactly once[\s\S]*not the Stalwart entry/);
    const doubled = html.replace('<title>', `${STALWART_BASE_HREF_LITERAL} /><title>`);
    expect(stalwartEntryProblems(doubled)[0]).toMatch(/found 2/);
    expect(stalwartEntryProblems(html.replace('<title>', '<script src="/_next/static/x.js"></script><title>')).join('\n')).toMatch(/root-absolute src="\/_next/);
    expect(stalwartEntryProblems(html.replace('<title>', '<script>fetch("/config.json")</script><title>')).join('\n')).toMatch(/config\.json absolutely/);
  });

  it('ships a manifest with relative URLs', () => {
    const manifest = buildStalwartManifest({ appName: 'Acme' });
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.icons.every((icon: { src: string }) => !icon.src.startsWith('/'))).toBe(true);
  });

  it('documents the install, reserved prefixes, updates and the redirect URI', () => {
    const readme = buildStalwartReadme({ version: '1.10.0', commit: 'abc1234', locales: ['en'], buildId: 'b' });
    // A tagged release by default: Stalwart verifies nothing it downloads.
    expect(readme).toContain(`resourceUrl='https://github.com/bulwarkmail/webmail/releases/download/v`);
    expect(readme).not.toContain(`resourceUrl='https://github.com/bulwarkmail/webmail/releases/latest`);
    expect(readme).toContain(`sha256sum -c ${STALWART_ZIP_NAME}.sha256`);
    expect(readme).toContain('stalwart-cli create Application');
    // The CLI wants JSON (verified against stalwart-cli 1.0.12), and nothing is mounted before UpdateApps.
    expect(readme).toContain(`--field 'urlPrefix={"/webmail":true}'`);
    expect(readme).toContain('stalwart-cli create Action/UpdateApps');
    expect(readme).toContain('"@type": "UpdateApps"');
    expect(readme).toContain('x:Application/set');
    expect(readme).toContain('sysApplicationCreate');
    expect(readme).toContain('actionUpdateApps');
    expect(readme).toContain('autoUpdateFrequency');
    expect(readme).toContain(`releases/download/v1.10.0/${STALWART_ZIP_NAME}`);
    expect(readme).toContain('https://mail.example.com/webmail/');
    for (const segment of ['`mail`', '`calendar`', '`admin`', '`account`']) expect(readme).toContain(segment);
  });
});

describe('Stalwart target: zip and emulator', () => {
  it('writes a zip that its own reader, jszip and Stalwart-style lookups agree on', async () => {
    const entries = [
      { name: 'index.html', data: Buffer.from('<base href="/" />'.repeat(50)) },
      { name: '_next/static/chunks/a.js', data: Buffer.from('x') },
      { name: 'en/mail/index.txt', data: Buffer.from('ü'.repeat(100)) },
    ];
    const zip = buildZip(entries);
    const listed = listZipEntries(zip);
    expect(listed.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(listed[0].method).toBe(8);
    expect(listed[1].method).toBe(0);
    for (let i = 0; i < entries.length; i++) expect(readZipEntry(zip, listed[i]).equals(entries[i].data)).toBe(true);
    const JSZip = (await import('jszip')).default;
    const parsed = await JSZip.loadAsync(zip);
    expect(await parsed.file('en/mail/index.txt')!.async('string')).toBe('ü'.repeat(100));
    // Identical input, identical bytes.
    expect(buildZip(entries).equals(zip)).toBe(true);
    expect(() => listZipEntries(Buffer.from('nope'))).toThrow(/not a zip/);
  });

  it('flags zip layouts Stalwart would serve wrongly', () => {
    expect(stalwartZipEntryProblems(['index.html', '_next/a.js', 'en/mail/index.html'])).toEqual([]);
    expect(stalwartZipEntryProblems(['bulwark/index.html'])[0]).toMatch(/archive root/);
    const problems = stalwartZipEntryProblems(['index.html', '404.html', '404/index.html', '_redirects', 'api/x.json', 'a\\b', '../x']).join('\n');
    expect(problems).toMatch(/404\.html belongs to the static-host target/);
    expect(problems).toMatch(/404\/index\.html belongs/);
    expect(problems).toMatch(/_redirects belongs/);
    expect(problems).toMatch(/top-level entry api shares its name/);
    expect(problems).toMatch(/unsafe entry name "a\\\\b"/);
    expect(problems).toMatch(/unsafe entry name "\.\.\/x"/);
  });

  it('emulates Stalwart request handling for Applications', () => {
    const entry = buildStalwartEntry({ locales: ['en'], shells: ['', 'mail'], buildId: 'b' });
    const entries = entriesOf({ 'index.html': entry, 'en/mail/index.html': '<html>shell</html>', 'en/mail/index.txt': 'rsc', 'config.json': '{}' });
    const serve = (pathname: string, extra: Partial<Parameters<typeof emulateStalwartRequest>[0]> = {}) =>
      emulateStalwartRequest({ pathname, entries, prefixes: ['/webmail', 'bulwark/'], oauthClientId: 'cid', ...extra });

    expect(serve('/webmail')).toMatchObject({ status: 302, headers: { location: '/webmail/' } });
    for (const path of ['/webmail/', '/webmail/en/mail/', '/webmail/en/mail/thread/1', '/webmail/nope']) {
      const res = serve(path);
      expect(res.status, path).toBe(200);
      expect(res.headers['cache-control'], path).toBe('no-cache');
      expect(res.headers['content-type'], path).toBe('text/html');
      expect(res.body.toString(), path).toContain('<base href="/webmail/" />');
      expect(res.body.toString(), path).toContain('<meta name="oauth-client-id" content="cid" />');
    }
    expect(serve('/bulwark/en/').body.toString()).toContain('<base href="/bulwark/" />');
    const exact = serve('/webmail/en/mail/index.html');
    expect(exact.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(exact.body.toString()).toBe('<html>shell</html>');
    expect(serve('/webmail/index.html').headers['cache-control']).toBe('no-cache');
    expect(serve('/webmail/en/mail/index.txt').headers['content-type']).toBe('application/octet-stream');
    expect(serve('/webmail/config.json').headers['content-type']).toBe('application/json');
    for (const path of ['/', '/mail/x', '/jmap', '/api/auth', '/other/']) expect(serve(path).status, path).toBe(404);
    expect(serve('/webmail/', { oauthClientId: '' }).body.toString()).toContain('<meta name="oauth-client-id" content="" />');
  });

  it('lists the shells below a locale', () => {
    const root = mkdtempSync(join(tmpdir(), 'bulwark-lite-shells-'));
    try {
      for (const dir of ['en', 'en/mail', 'en/auth/callback', 'en/mail/__next.x', 'en/_not-found']) {
        mkdirSync(join(root, ...dir.split('/')), { recursive: true });
        writeFileSync(join(root, ...dir.split('/'), 'index.html'), '');
      }
      mkdirSync(join(root, 'en', 'auth'), { recursive: true });
      expect(discoverShellDirs(root, 'en')).toEqual(['', 'auth/callback', 'mail']);
      expect(discoverShellDirs(root, 'fr')).toEqual([]);
      expect(collectZipEntries(join(root, 'en')).map((e) => e.name)).toEqual(['_not-found/index.html', 'auth/callback/index.html', 'index.html', 'mail/__next.x/index.html', 'mail/index.html']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a same-origin config for the Stalwart target', () => {
    const config = buildLiteConfig({}, { target: 'stalwart' });
    expect(config.jmapServerUrl).toBe('');
    expect(config.allowCustomJmapEndpoint).toBe(false);
    expect(config.rememberMeEnabled).toBe(true);
    expect(config.demoMode).toBe(false);
    expect(config._comment).toMatch(/Read-only inside the Application bundle/);
    expect(buildLiteConfig({ LITE_ALLOW_CUSTOM_ENDPOINT: 'true' }, { target: 'stalwart' }).allowCustomJmapEndpoint).toBe(true);
  });
});

describe('Stalwart target: postbuild + verify against a fake checkout', () => {
  function makeExport(root: string) {
    const out = join(root, 'out');
    for (const locale of ['en', 'de']) {
      for (const surface of ['mail', 'calendar', 'contacts', 'files', 'settings', 'login']) {
        mkdirSync(join(out, locale, surface), { recursive: true });
        writeFileSync(join(out, locale, surface, 'index.html'), '<html><head></head></html>');
        writeFileSync(join(out, locale, surface, 'index.txt'), '0:I[1,["/_next/static/chunks/a.js"],"x"]\n1:T3,abc');
        // Next 16.3's nested segment-prefetch tree (requested with dots, never read) and the flat files.
        mkdirSync(join(out, locale, surface, '__next.!KG1haW4p', '$d$locale'), { recursive: true });
        writeFileSync(join(out, locale, surface, '__next.!KG1haW4p', '$d$locale.txt'), 'seg');
        writeFileSync(join(out, locale, surface, '__next._tree.txt'), 'tree');
      }
      writeFileSync(join(out, locale, 'index.html'), '<html></html>');
    }
    mkdirSync(join(out, '_next', 'static', 'chunks'), { recursive: true });
    mkdirSync(join(out, '_next', 'static', 'media'), { recursive: true });
    writeFileSync(join(out, '_next', 'static', 'chunks', 'app.js'), 'fetch("/api/config")');
    writeFileSync(join(out, '_next', 'static', 'media', 'pdf.worker.min.abc.mjs'), 'worker()');
    mkdirSync(join(out, 'branding'), { recursive: true });
    mkdirSync(join(out, '404'), { recursive: true });
    writeFileSync(join(out, '404', 'index.html'), 'next 404');
    writeFileSync(join(out, '404.html'), 'next 404');
    return out;
  }

  it('writes the entry, drops static-host files, copies .mjs as .js, packs and verifies the zip', () => {
    const root = makeRepo();
    try {
      const out = makeExport(root);
      const result = runPostbuild({ root, env: env({ LITE_TARGET: 'stalwart', NEXT_PUBLIC_LITE_BUILD_ID: 'bid-1', GIT_COMMIT: 'abcdef1234567' }), log: () => {} });
      expect(result.target).toBe('stalwart');
      expect(result.buildId).toBe('bid-1');
      expect(result.zipPath).toBe(join(root, STALWART_ZIP_NAME));
      for (const file of ['index.html', 'config.json', 'policy.json', 'manifest.json', 'LITE-README.md', 'lite-build.json']) expect(existsSync(join(out, file)), file).toBe(true);
      for (const file of ['404.html', '404', '_redirects', '_headers', 'nginx.conf.example', 'Caddyfile.example', 'manifest.webmanifest']) expect(existsSync(join(out, file)), file).toBe(false);
      expect(readFileSync(join(out, '_next', 'static', 'media', 'pdf.worker.min.abc.js'), 'utf8')).toBe('worker()');
      expect(existsSync(join(out, 'en', 'mail', '__next.!KG1haW4p'))).toBe(false);
      expect(existsSync(join(out, 'en', 'mail', '__next._tree.txt'))).toBe(true);
      expect(findSegmentPrefetchDirs(out)).toEqual([]);
      const entry = readFileSync(join(out, 'index.html'), 'utf8');
      expect(entry).toContain('var BUILD_ID = "bid-1"');
      expect(entry).toContain('var SHELLS = ["","calendar","contacts","files","login","mail","settings"]');
      expect(JSON.parse(readFileSync(join(out, 'lite-build.json'), 'utf8'))).toMatchObject({ target: 'stalwart', buildId: 'bid-1', commit: 'abcdef1' });
      expect(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')).allowCustomJmapEndpoint).toBe(false);

      const names = listZipEntries(readFileSync(result.zipPath!)).map((e) => e.name);
      expect(names).toContain('index.html');
      expect(names).toContain('en/mail/index.html');
      expect(names.some((n) => n.startsWith('out/'))).toBe(false);

      const verdict = verifyExport({ root });
      expect(verdict.target).toBe('stalwart');
      expect(verdict.problems).toEqual([]);
      expect(verdict.zipBytes).toBeGreaterThan(0);

      // Size guard: above the safety margin fails.
      expect(verifyExport({ root, safeBundleBytes: 10 }).problems.join('\n')).toMatch(/safety margin/);
      // A text row holding an asset URL would never be rewritten.
      writeFileSync(join(out, 'en', 'mail', 'index.txt'), '1:T8,"/_next/');
      expect(verifyExport({ root }).problems.join('\n')).toMatch(/text rows 1 hold root-absolute URLs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a baked base path and reports a missing zip', () => {
    const root = makeRepo();
    try {
      makeExport(root);
      expect(() => runPostbuild({ root, env: env({ LITE_TARGET: 'stalwart', NEXT_PUBLIC_BASE_PATH: '/webmail' }), log: () => {} })).toThrow(/unset NEXT_PUBLIC_BASE_PATH/);
      expect(verifyExport({ root, target: 'stalwart' }).problems.join('\n')).toMatch(/missing bulwark-lite-stalwart\.zip/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the static target unchanged', () => {
    const root = makeRepo();
    try {
      makeExport(root);
      const result = runPostbuild({ root, env: env({}), log: () => {} });
      expect(result.target).toBe('static');
      expect(result.zipPath).toBeNull();
      expect(existsSync(join(root, 'out', '_redirects'))).toBe(true);
      expect(readFileSync(join(root, 'out', '404.html'), 'utf8')).toContain(LITE_PENDING_PATH_KEY);
      // Static hosts keep the segment-prefetch trees untouched (2 locales x 6 surfaces).
      expect(findSegmentPrefetchDirs(join(root, 'out'))).toHaveLength(12);
      expect(existsSync(join(root, STALWART_ZIP_NAME))).toBe(false);
      expect(verifyExport({ root }).problems).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
