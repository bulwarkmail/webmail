/**
 * A page load of the root with no session cookie and no kept accounts goes
 * straight to the sign-in page (lib/signed-out-start.ts, proxy.ts). The mail
 * view used to start first and find out.
 */
import { describe, it, expect } from 'vitest';
import {
  applySignedOutStart,
  signedOutStartScript,
  signedOutStartTarget,
  LOCAL_COOKIE,
  START_COOKIE,
  type StartRequest,
  type StartScriptConfig,
} from '@/lib/signed-out-start';
import { COOKIES_TO_CLEAR_KEY } from '@/lib/app-lock/sign-out';

const LOCALES = ['de', 'en', 'zh-TW'];

function req(over: Partial<StartRequest> & { headers?: Record<string, string> } = {}): StartRequest {
  const headers: Record<string, string> = { 'sec-fetch-dest': 'document', accept: 'text/html', ...(over.headers ?? {}) };
  return {
    method: 'GET',
    pathname: '/',
    search: '',
    header: (name) => headers[name] ?? null,
    cookieNames: [],
    locales: LOCALES,
    intlRedirect: null,
    demoMode: false,
    ...over,
  };
}

describe('signedOutStartTarget', () => {
  it('sends a first page load of the root to the sign-in page', () => {
    expect(signedOutStartTarget(req())).toBe('/login');
    expect(signedOutStartTarget(req({ cookieNames: ['NEXT_LOCALE', 'theme'] }))).toBe('/login');
  });

  it('follows the locale the locale middleware redirects to, in one step', () => {
    expect(signedOutStartTarget(req({ intlRedirect: '/de' }))).toBe('/de/login');
    expect(signedOutStartTarget(req({ intlRedirect: '/zh-TW/' }))).toBe('/zh-TW/login');
    // A redirect elsewhere is the middleware's business.
    expect(signedOutStartTarget(req({ intlRedirect: '/de/settings' }))).toBeNull();
  });

  it('handles a locale root that skipped the middleware', () => {
    expect(signedOutStartTarget(req({ pathname: '/de' }))).toBe('/de/login');
    expect(signedOutStartTarget(req({ pathname: '/xx' }))).toBeNull();
  });

  it('leaves the mail view to any session cookie or the kept-accounts marker', () => {
    expect(signedOutStartTarget(req({ cookieNames: ['jmap_session_0'] }))).toBeNull();
    expect(signedOutStartTarget(req({ cookieNames: ['jmap_rt'] }))).toBeNull();
    expect(signedOutStartTarget(req({ cookieNames: ['jmap_impersonation'] }))).toBeNull();
    expect(signedOutStartTarget(req({ cookieNames: [LOCAL_COOKIE] }))).toBeNull();
  });

  it('only redirects a top-level page load of the bare root', () => {
    expect(signedOutStartTarget(req({ pathname: '/mail/message/abc' }))).toBeNull();
    expect(signedOutStartTarget(req({ pathname: '/settings' }))).toBeNull();
    expect(signedOutStartTarget(req({ search: '?mailto=x' }))).toBeNull();
    expect(signedOutStartTarget(req({ method: 'HEAD' }))).toBeNull();
    expect(signedOutStartTarget(req({ headers: { rsc: '1' } }))).toBeNull();
    expect(signedOutStartTarget(req({ headers: { 'next-router-prefetch': '1' } }))).toBeNull();
    expect(signedOutStartTarget(req({ headers: { 'x-bulwark-reload-probe': '1' } }))).toBeNull();
    expect(signedOutStartTarget(req({ headers: { 'sec-fetch-dest': 'iframe' } }))).toBeNull();
    expect(signedOutStartTarget(req({ headers: { 'sec-fetch-dest': 'empty' } }))).toBeNull();
  });

  it('never redirects in demo mode', () => {
    expect(signedOutStartTarget(req({ demoMode: true }))).toBeNull();
  });
});

interface Fake {
  w: Window;
  d: Document;
  cookies: Map<string, string>;
  replaced: string[];
}

function fakePage(path: string, storage: Record<string, string>, cookies: Record<string, string> = {}, extra: Record<string, unknown> = {}): Fake {
  const jar = new Map(Object.entries(cookies));
  const replaced: string[] = [];
  const d = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(line: string) {
      const [pair, ...attrs] = line.split(';');
      const [name, value] = pair.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    },
  } as unknown as Document;
  const w = {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    location: { pathname: path, protocol: 'https:', replace: (to: string) => replaced.push(to) },
    ...extra,
  } as unknown as Window;
  return { w, d, cookies: jar, replaced };
}

const CFG: StartScriptConfig = { local: LOCAL_COOKIE, start: START_COOKIE, clear: COOKIES_TO_CLEAR_KEY, path: '/' };
const ACCOUNTS = { 'account-registry': JSON.stringify({ state: { accounts: [{ id: 'a' }] } }) };

describe('applySignedOutStart', () => {
  it('keeps the marker while accounts are kept, so the root starts the mail view', () => {
    const page = fakePage('/', ACCOUNTS);
    applySignedOutStart(page.w, page.d, CFG);
    expect(page.cookies.get(LOCAL_COOKIE)).toBe('1');
  });

  it('counts a pending cookie clear, a stored sign-in and the desktop app as something to restore', () => {
    for (const page of [
      fakePage('/', { [COOKIES_TO_CLEAR_KEY]: '1' }),
      fakePage('/', { 'auth-storage': JSON.stringify({ state: { isAuthenticated: true } }) }),
      fakePage('/', {}, {}, { bulwarkDesktop: {} }),
    ]) {
      applySignedOutStart(page.w, page.d, CFG);
      expect(page.cookies.get(LOCAL_COOKIE)).toBe('1');
    }
  });

  it('drops the marker on the sign-in page once nothing is kept, and nowhere else', () => {
    const elsewhere = fakePage('/settings', {}, { [LOCAL_COOKIE]: '1' });
    applySignedOutStart(elsewhere.w, elsewhere.d, CFG);
    expect(elsewhere.cookies.has(LOCAL_COOKIE)).toBe(true);
    const login = fakePage('/de/login', {}, { [LOCAL_COOKIE]: '1' });
    applySignedOutStart(login.w, login.d, CFG);
    expect(login.cookies.has(LOCAL_COOKIE)).toBe(false);
  });

  it('sends a redirected sign-in page back to the root when accounts were kept without the marker', () => {
    const page = fakePage('/de/login', ACCOUNTS, { [START_COOKIE]: '1' });
    applySignedOutStart(page.w, page.d, CFG);
    expect(page.replaced).toEqual(['/de']);
    expect(page.cookies.get(LOCAL_COOKIE)).toBe('1');
    expect(page.cookies.has(START_COOKIE)).toBe(false);
    const bare = fakePage('/login', ACCOUNTS, { [START_COOKIE]: '1' });
    applySignedOutStart(bare.w, bare.d, CFG);
    expect(bare.replaced).toEqual(['/']);
  });

  it('stays on the sign-in page after a redirect with nothing kept', () => {
    const page = fakePage('/login', {}, { [START_COOKIE]: '1' });
    applySignedOutStart(page.w, page.d, CFG);
    expect(page.replaced).toEqual([]);
    expect(page.cookies.has(START_COOKIE)).toBe(false);
    expect(page.cookies.has(LOCAL_COOKIE)).toBe(false);
  });

  it('starts the mail view when storage cannot be read', () => {
    const page = fakePage('/', {});
    (page.w as unknown as { localStorage: unknown }).localStorage = { getItem: () => { throw new Error('blocked'); } };
    applySignedOutStart(page.w, page.d, CFG);
    expect(page.cookies.get(LOCAL_COOKIE)).toBe('1');
  });

  it('runs as the inline script it is shipped as', () => {
    const script = signedOutStartScript('/webmail');
    expect(script).toContain('"path":"/webmail"');
    const page = fakePage('/webmail', ACCOUNTS);
    new Function('window', 'document', script)(page.w, page.d);
    expect(page.cookies.get(LOCAL_COOKIE)).toBe('1');
  });
});
