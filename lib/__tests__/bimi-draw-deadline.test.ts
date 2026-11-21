// @vitest-environment node
/**
 * The drawing deadline is for the logo: a logo that draws for long is given up on and remembered
 * as "no logo" for hours, for every user. When the server itself is busy for a moment (a cold
 * start, a large page being rendered), that time must not count against the logo: a logo the
 * child drew in time is shown, not given up on.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const afterReady = vi.hoisted(() => ({ run: null as null | (() => void) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    const child = actual.spawn(command, args, options as never) as unknown as ChildProcess;
    // Registered before the drawing code's own handler, so this runs just after that handler
    // has seen the child's first output.
    child.stdout?.once('data', () => { setImmediate(() => afterReady.run?.()); });
    return child;
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import { DRAW_DEADLINE_MS, LogoDrawingError, rasterize } from '@/lib/bimi/draw';

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title><rect width="100" height="100" fill="#06c"/></svg>';

/** Keeps this process's only thread busy, as a long synchronous piece of work does. */
function busyFor(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('the drawing deadline', () => {
  // Control: an ordinary logo is drawn when the server is idle.
  it('draws an ordinary logo', async () => {
    afterReady.run = null;
    const png = await rasterize(LOGO);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  }, 30_000);

  it('does not give up on a logo the child drew in time while the server was busy', async () => {
    afterReady.run = () => busyFor(DRAW_DEADLINE_MS + 500);
    const outcome = await rasterize(LOGO).then((png) => png.subarray(1, 4).toString('latin1'), (err: Error) => err.message);
    expect(outcome).toBe('PNG');
  }, 30_000);

  // A logo that keeps the drawing library busy (one filtered group, a thousand times) is the logo's
  // own doing: given up on in its own time, and not "try again later".
  it('gives up on a logo that draws past its own time, as the logo\'s fault', async () => {
    afterReady.run = null;
    let defs = '<g id="a0" filter="url(#f)"><rect width="100" height="100" fill="#f00"/></g>';
    for (let i = 1; i <= 3; i++) defs += `<g id="a${i}">${`<use href="#a${i - 1}"/>`.repeat(10)}</g>`;
    const slow = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title>'
      + `<filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.9" numOctaves="12"/></filter><defs>${defs}</defs><use href="#a3"/></svg>`;
    const stopped: boolean[] = [];
    const error = await rasterize(slow, { onStopped: () => stopped.push(true) }).then(() => null, (err: { temporary?: boolean; message: string }) => err);
    expect(error?.temporary).toBe(false);
    expect(error?.message).toContain('gave up');
    await vi.waitFor(() => expect(stopped).toEqual([true]));
  }, 30_000);

  // No drawing process at all is the server's trouble, and worth telling apart from a busy moment.
  it('says so when the drawing process could not be started', async () => {
    afterReady.run = null;
    const node = process.execPath;
    process.execPath = `${node}-is-not-here`;
    let error: { temporary?: boolean; neverStarted?: boolean; message: string } | null;
    try {
      error = await rasterize(LOGO).then(() => null, (err) => err);
    } finally {
      process.execPath = node;
    }
    expect(error?.message).toContain('could not start');
    expect(error?.temporary).toBe(true);
    expect(error?.neverStarted).toBe(true);
    // A logo that ran out its own time did start.
    expect(new LogoDrawingError('gave up', false).neverStarted).toBe(false);
  }, 30_000);
});
