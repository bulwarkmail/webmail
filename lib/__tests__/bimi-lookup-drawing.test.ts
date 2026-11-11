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

import { rasterize } from '@/lib/bimi/svg';
import { createBimiResolver } from '@/lib/bimi/lookup';

const T0 = Date.UTC(2026, 9, 29);

/** Domains d0.example ... with DMARC and a self-published logo, or a certificate when `certified`. */
function setup({ certified = false } = {}) {
  const clock = { now: T0 };
  const resolver = createBimiResolver({
    resolveTxt: async (name: string) => {
      if (name.startsWith('_dmarc.')) return [['v=DMARC1; p=reject']];
      const domain = name.replace(/^default\._bimi\./, '');
      return [[certified ? `v=BIMI1; l=; a=https://cdn.${domain}/vmc.pem` : `v=BIMI1; l=https://cdn.${domain}/logo.svg`]];
    },
    fetchBytes: async (url: string) => new Uint8Array(Buffer.from(url.endsWith('.pem') ? 'PEM' : LOGO)),
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
