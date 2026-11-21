// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkCertificate } from '@/lib/bimi/certificate';

// How the resolver uses the drawing: how many logos it draws at once, what it remembers when a
// drawing fails, and that a logo out of a mark certificate goes the same way as a self-published one.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const LOGO = '<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Brand</title><rect width="10" height="10" fill="#c00"/></svg>';
const FILTERED = '<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Brand</title>'
  + '<filter id="f"><feTurbulence baseFrequency="0.9" numOctaves="12"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>';

type Draw = (svg: string, onStopped: () => void) => Promise<Buffer>;
const drawing = vi.hoisted(() => ({ impl: null as null | Draw }));
vi.mock('@/lib/bimi/svg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bimi/svg')>();
  return {
    ...actual,
    rasterize: vi.fn((svg: string, options?: { onStopped?: () => void }) => drawing.impl!(svg, options?.onStopped ?? (() => {}))),
  };
});
const certificate = vi.hoisted(() => ({ svg: '' }));
vi.mock('@/lib/bimi/certificate', () => ({
  validateMarkCertificate: vi.fn(async () => ({
    ok: true,
    mark: { svg: certificate.svg, markType: 'verified', organization: 'Brand Ltd', issuer: 'Mark CA', notAfter: Date.UTC(2030, 0, 1) } satisfies MarkCertificate,
  })),
}));

import { logger } from '@/lib/logger';
import { rasterize } from '@/lib/bimi/svg';
import { createBimiResolver, SESSIONLESS_CACHE_MAX, SESSIONLESS_MAX_IN_FLIGHT } from '@/lib/bimi/lookup';

const T0 = Date.UTC(2026, 9, 29);

/** Domains d0.example ... with DMARC and a self-published logo, or a certificate when `certified`. */
function setup({ certified = false, logo = LOGO } = {}) {
  const clock = { now: T0 };
  const resolver = createBimiResolver({
    resolveTxt: async (name: string) => {
      if (name.startsWith('_dmarc.')) return [['v=DMARC1; p=reject']];
      const domain = name.replace(/^default\._bimi\./, '');
      return [[certified ? `v=BIMI1; l=; a=https://cdn.${domain}/vmc.pem` : `v=BIMI1; l=https://cdn.${domain}/logo.svg`]];
    },
    fetchBytes: async (url: string) => new Uint8Array(Buffer.from(url.endsWith('.pem') ? 'PEM' : logo)),
    roots: () => [],
    now: () => clock.now,
  });
  return { resolver, clock };
}

/** A drawing that waits to be finished by hand, counting how many run at once. */
function heldDrawings() {
  const pending: Array<() => void> = [];
  const state = { running: 0, most: 0 };
  drawing.impl = (_svg, onStopped) => new Promise((resolve) => {
    state.running++;
    state.most = Math.max(state.most, state.running);
    pending.push(() => {
      state.running--;
      onStopped();
      resolve(PNG);
    });
  });
  const finishAll = async (done: Promise<unknown>) => {
    let settled = false;
    void done.then(() => { settled = true; });
    while (!settled) {
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { state, finishAll };
}

const failure = (temporary: boolean) => Object.assign(new Error(temporary ? 'could not start' : 'gave up'), { temporary });

beforeEach(() => {
  vi.mocked(rasterize).mockClear();
  certificate.svg = LOGO;
});

describe('the resolver draws', () => {
  it('at most two logos at once', async () => {
    const { resolver } = setup();
    const { state, finishAll } = heldDrawings();
    const all = Promise.all([0, 1, 2, 3, 4].map((i) => resolver.resolve(`d${i}.example`)));
    await vi.waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
    await finishAll(all);
    expect((await all).every((indicator) => indicator?.status === 'self-asserted')).toBe(true);
    expect(rasterize).toHaveBeenCalledTimes(5);
    expect(state.most).toBe(2);
  });

  it('remembers a logo it gave up on as no logo, and does not draw it again', async () => {
    const { resolver, clock } = setup();
    drawing.impl = async (_svg, onStopped) => { onStopped(); throw failure(false); };
    expect(await resolver.resolve('d0.example')).toBeNull();
    expect(await resolver.resolve('d0.example')).toBeNull();
    clock.now += 60 * 60 * 1000;
    expect(await resolver.resolve('d0.example')).toBeNull();
    expect(rasterize).toHaveBeenCalledTimes(1);
  });

  it('tries again soon when the drawing never started', async () => {
    const { resolver, clock } = setup();
    drawing.impl = async (_svg, onStopped) => { onStopped(); throw failure(true); };
    expect(await resolver.resolve('d0.example')).toBeNull();
    expect(rasterize).toHaveBeenCalledTimes(1);
    clock.now += 11 * 60 * 1000;
    drawing.impl = async (_svg, onStopped) => { onStopped(); return PNG; };
    expect((await resolver.resolve('d0.example'))?.status).toBe('self-asserted');
    expect(rasterize).toHaveBeenCalledTimes(2);
  });

  it('answers "not now" and remembers nothing when the server was too busy to finish the drawing', async () => {
    const { resolver } = setup();
    drawing.impl = async (_svg, onStopped) => { onStopped(); throw failure(true); };
    expect(await resolver.answer('d0.example')).toEqual({ indicator: null, deferred: true });
    drawing.impl = async (_svg, onStopped) => { onStopped(); return PNG; };
    // Asked again at once: drawn now, not "no logo" from the first try.
    expect((await resolver.answer('d0.example')).indicator?.status).toBe('self-asserted');
    expect(rasterize).toHaveBeenCalledTimes(2);
  });

  it('warns once a minute while the drawing process does not start, and not for a busy moment', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const { resolver, clock } = setup();
      const notStarted = () => Object.assign(new Error('drawing could not start: spawn EPERM'), { temporary: true, neverStarted: true });
      const warnings = () => warn.mock.calls.filter(([message]) => /does not start/.test(String(message)));

      drawing.impl = async (_svg, onStopped) => { onStopped(); throw failure(true); };
      expect(await resolver.answer('d0.example')).toEqual({ indicator: null, deferred: true });
      expect(warnings()).toHaveLength(0);

      drawing.impl = async (_svg, onStopped) => { onStopped(); throw notStarted(); };
      for (const domain of ['d1.example', 'd2.example', 'd3.example']) {
        expect(await resolver.answer(domain)).toEqual({ indicator: null, deferred: true });
      }
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][1]).toEqual({ domain: 'd1.example', reason: 'drawing could not start: spawn EPERM' });

      clock.now += 61_000;
      await resolver.answer('d4.example');
      await resolver.answer('d5.example');
      expect(warnings()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('draws the checked document, not the text that came in', async () => {
    const logo = '<?xml version="1.0"?><!-- tool --><svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
      + '<title>Brand</title><rect id="&#115;q" width="10" height="10" fill="#c00"/></svg>';
    const { resolver } = setup({ logo });
    drawing.impl = async (_svg, onStopped) => { onStopped(); return PNG; };
    expect((await resolver.resolve('d0.example'))?.status).toBe('self-asserted');
    const drawn = vi.mocked(rasterize).mock.calls[0][0];
    expect(drawn).not.toContain('<!--');
    expect(drawn).not.toContain('<?xml');
    expect(drawn).toContain('id="sq"');
  });
});

describe('a logo out of a mark certificate', () => {
  it('goes through the same check: a filter is refused before drawing', async () => {
    certificate.svg = FILTERED;
    const { resolver } = setup({ certified: true });
    drawing.impl = async (_svg, onStopped) => { onStopped(); return PNG; };
    expect(await resolver.resolve('d0.example')).toBeNull();
    expect(rasterize).not.toHaveBeenCalled();
  });

  it('shares the drawing slots with self-published logos', async () => {
    const { resolver } = setup({ certified: true });
    const { state, finishAll } = heldDrawings();
    const all = Promise.all([0, 1, 2, 3].map((i) => resolver.resolve(`d${i}.example`)));
    await vi.waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
    await finishAll(all);
    expect((await all).every((indicator) => indicator?.status === 'verified')).toBe(true);
    expect(state.most).toBe(2);
  });
});

// Lookups for callers without a session (the third argument of answer) run in a pool of their own.
describe('lookups for callers without a session', () => {
  /** Every domain has a logo with the domain as its title; drawings are finished by hand, by that name. */
  function setupNamed() {
    const resolver = createBimiResolver({
      resolveTxt: async (name: string) => (name.startsWith('_dmarc.')
        ? [['v=DMARC1; p=reject']]
        : [[`v=BIMI1; l=https://cdn.${name.replace(/^default\._bimi\./, '')}/logo.svg`]]),
      fetchBytes: async (url: string) => new Uint8Array(Buffer.from(LOGO.replace('Brand', new URL(url).hostname.replace(/^cdn\./, '')))),
      roots: () => [],
      now: () => T0,
    });
    /** The domains whose logos were handed to the drawing, in that order. */
    const drawn: string[] = [];
    const finishers = new Map<string, () => void>();
    drawing.impl = (svg, onStopped) => new Promise((resolve) => {
      const name = /<title>([^<]*)<\/title>/.exec(svg)![1];
      drawn.push(name);
      finishers.set(name, () => {
        onStopped();
        resolve(PNG);
      });
    });
    const finish = (name: string) => finishers.get(name)!();
    /** Time for a lookup that may draw to get there. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    return { resolver, drawn, finish, settle };
  }

  it('draw one logo at a time and leave the other slot to signed-in users', async () => {
    const { resolver, drawn, finish, settle } = setupNamed();
    const app = ['app1.example', 'app2.example', 'app3.example'].map((domain) => resolver.answer(domain, undefined, true));
    await settle();
    expect(drawn).toEqual(['app1.example']);
    // A signed-in lookup draws at once, next to it.
    const mail = resolver.answer('mail1.example');
    await settle();
    expect(drawn).toEqual(['app1.example', 'mail1.example']);
    finish('mail1.example');
    await settle();
    // The free slot is not theirs: the second one draws when the first is done.
    expect(drawn).toEqual(['app1.example', 'mail1.example']);
    finish('app1.example');
    await settle();
    expect(drawn).toEqual(['app1.example', 'mail1.example', 'app2.example']);
    finish('app2.example');
    await settle();
    finish('app3.example');
    expect((await Promise.all([...app, mail])).every((answer) => answer.indicator?.status === 'self-asserted')).toBe(true);
  });

  it('never draw while a signed-in lookup waits for a slot', async () => {
    const { resolver, drawn, finish, settle } = setupNamed();
    const first = [resolver.answer('mail1.example'), resolver.answer('mail2.example')];
    await settle();
    expect(drawn).toEqual(['mail1.example', 'mail2.example']);
    // Both slots are busy. The app's lookup asks first, a signed-in one after it.
    const app = resolver.answer('app1.example', undefined, true);
    await settle();
    const third = resolver.answer('mail3.example');
    await settle();
    finish('mail1.example');
    await settle();
    expect(drawn).toEqual(['mail1.example', 'mail2.example', 'mail3.example']);
    finish('mail2.example');
    await settle();
    expect(drawn).toEqual(['mail1.example', 'mail2.example', 'mail3.example', 'app1.example']);
    finish('mail3.example');
    finish('app1.example');
    expect((await Promise.all([...first, app, third])).every((answer) => answer.indicator?.status === 'self-asserted')).toBe(true);
  });

  it('are answered from the cache of signed-in lookups, and can neither empty it nor renew an entry in it', async () => {
    const asked = new Map<string, number>();
    const clock = { now: T0 };
    const resolver = createBimiResolver({
      // No DMARC record anywhere: every lookup ends as "no logo".
      resolveTxt: async (name: string) => {
        asked.set(name, (asked.get(name) ?? 0) + 1);
        return [];
      },
      fetchBytes: async () => null,
      roots: () => [],
      now: () => clock.now,
    });
    const lookups = (domain: string) => asked.get(`_dmarc.${domain}`) ?? 0;
    const total = () => [...asked.values()].reduce((sum, n) => sum + n, 0);

    // As many names as the cache of signed-in lookups holds, then more than that for the app.
    const mail = Array.from({ length: 2000 }, (_, i) => `mail${i}.example`);
    for (const domain of mail) await resolver.answer(domain);
    const app = Array.from({ length: 300 }, (_, i) => `app${i}.example`);
    for (const domain of app) await resolver.answer(domain, undefined, true);
    expect(total()).toBe(mail.length + app.length);

    // Every name a signed-in user asked about is still known, to both kinds of caller.
    for (const domain of mail) await resolver.answer(domain);
    expect(await resolver.answer(mail[0], undefined, true)).toEqual({ indicator: null, deferred: false });
    expect(total()).toBe(mail.length + app.length);
    // The app's own answers are few: the oldest was dropped, the newest is kept.
    expect(SESSIONLESS_CACHE_MAX).toBeLessThan(app.length);
    await resolver.answer(app[0], undefined, true);
    await resolver.answer(app[app.length - 1], undefined, true);
    expect([lookups(app[0]), lookups(app[app.length - 1])]).toEqual([2, 1]);
    // A signed-in caller does not take the app's answer for its own.
    await resolver.answer(app[app.length - 1]);
    expect(lookups(app[app.length - 1])).toBe(2);

    // An entry of the signed-in cache that ran out is renewed by a signed-in lookup only.
    clock.now += 7 * 60 * 60 * 1000;
    await resolver.answer(mail[5], undefined, true);
    await resolver.answer(mail[5], undefined, true);
    expect(lookups(mail[5])).toBe(2);
    await resolver.answer(mail[5]);
    expect(lookups(mail[5])).toBe(3);
    await resolver.answer(mail[5]);
    await resolver.answer(mail[5], undefined, true);
    expect(lookups(mail[5])).toBe(3);
  });

  it('run a few at once, next to all the lookups signed-in users may run', async () => {
    const held: Array<() => void> = [];
    const resolver = createBimiResolver({
      resolveTxt: (name: string) => new Promise((resolve) => {
        if (name.startsWith('_dmarc.')) held.push(() => resolve([]));
        else resolve([]);
      }),
      fetchBytes: async () => null,
      roots: () => [],
      now: () => T0,
    });
    const app = Array.from({ length: 20 }, (_, i) => resolver.answer(`app${i}.example`, undefined, true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(held).toHaveLength(SESSIONLESS_MAX_IN_FLIGHT);
    const mail = Array.from({ length: 70 }, (_, i) => resolver.answer(`mail${i}.example`));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(held).toHaveLength(SESSIONLESS_MAX_IN_FLIGHT + 64);
    // The app's lookup for a name a signed-in lookup is already asking about waits for that one.
    const joined = resolver.answer('mail0.example', undefined, true);
    for (const go of held.splice(0)) go();
    expect(await joined).toEqual({ indicator: null, deferred: false });
    const answers = await Promise.all([...app, ...mail]);
    expect(answers.filter((answer) => answer.deferred)).toHaveLength(20 - SESSIONLESS_MAX_IN_FLIGHT + 70 - 64);
  });

  it('ask a caller whether it may start a lookup only when the lookup has room to run', async () => {
    const held: Array<() => void> = [];
    const resolver = createBimiResolver({
      resolveTxt: () => new Promise((resolve) => { held.push(() => resolve([])); }),
      fetchBytes: async () => null,
      roots: () => [],
      now: () => T0,
    });
    // The answer takes a moment, as a count kept in the shared store does.
    const asked = { app: 0, mail: 0 };
    const mayStart = (who: 'app' | 'mail', allowed = true) => async () => {
      asked[who]++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return allowed;
    };
    // More new names at once than either kind of caller may have running.
    const app = Array.from({ length: 20 }, (_, i) => resolver.answer(`app${i}.example`, mayStart('app'), true));
    const mail = Array.from({ length: 70 }, (_, i) => resolver.answer(`mail${i}.example`, mayStart('mail')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(asked).toEqual({ app: SESSIONLESS_MAX_IN_FLIGHT, mail: 64 });
    expect(held).toHaveLength(SESSIONLESS_MAX_IN_FLIGHT + 64);
    for (const go of held.splice(0)) go();
    await Promise.all([...app, ...mail]);

    // A caller that may not start gives its place back: the next one is asked and runs.
    const refused = await Promise.all(Array.from({ length: SESSIONLESS_MAX_IN_FLIGHT }, (_, i) => resolver.answer(`later${i}.example`, mayStart('app', false), true)));
    expect(refused.every((answer) => answer.deferred)).toBe(true);
    const next = resolver.answer('next.example', mayStart('app'), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(held).toHaveLength(1);
    held[0]();
    expect(await next).toEqual({ indicator: null, deferred: false });
  });
});
