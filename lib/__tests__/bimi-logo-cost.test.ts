// @vitest-environment node
/**
 * A sender logo is fetched from an address the sender's DNS names, checked and drawn on the server.
 * Two rules:
 *  1. The check accepts only what the SVG Tiny PS profile allows. Filters, masks, patterns, styles
 *     and a <use> that multiplies itself are refused before anything is drawn.
 *  2. Drawing never holds the server up. rasterize() gives up on a logo that would draw for a long
 *     time, and while logos are being drawn the rest of the process still reads files.
 *
 * Rule 2 is tested on rasterize() itself, with a logo the check of rule 1 refuses, because the
 * drawing must be bounded whatever the check lets through. It asserts on what happened and in which
 * order, not on durations; the 15 s below is only how long the test waits before it calls a drawing
 * "still running".
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { checkSvg, rasterize } from '@/lib/bimi/svg';

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title>';
const TAIL = '</svg>';
const FILTER = '<filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.9" numOctaves="12"/></filter>';

/** `10 ** levels` uses of one filtered group: the cost grows with the number of uses, the size hardly. */
function filteredUses(levels: number): string {
  let defs = '<g id="a0" filter="url(#f)"><rect width="100" height="100" fill="#f00"/></g>';
  for (let i = 1; i <= levels; i++) defs += `<g id="a${i}">${`<use href="#a${i - 1}"/>`.repeat(10)}</g>`;
  return `${HEAD}${FILTER}<defs>${defs}</defs><use href="#a${levels}"/>${TAIL}`;
}

/** 10^12 uses of a plain rectangle. */
function plainUses(): string {
  let defs = '<g id="a0"><rect width="1" height="1"/></g>';
  for (let i = 1; i <= 12; i++) defs += `<g id="a${i}">${`<use href="#a${i - 1}"/>`.repeat(10)}</g>`;
  return `${HEAD}<defs>${defs}</defs><use href="#a12"/>${TAIL}`;
}

const refused = (svg: string) => checkSvg(svg, { strictProfile: true }) !== null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the check of a self-published logo', () => {
  it('refuses filters', () => {
    expect(Buffer.byteLength(filteredUses(5))).toBeLessThan(32 * 1024);
    expect(refused(filteredUses(5))).toBe(true);
    expect(refused(`${HEAD}${FILTER}<rect width="100" height="100" filter="url(#f)"/>${TAIL}`)).toBe(true);
  });

  it('refuses a logo that multiplies itself through nested <use>', () => {
    expect(refused(plainUses())).toBe(true);
  });

  it.each([
    ['mask', '<mask id="m"><rect width="100" height="100" fill="#fff"/></mask><rect width="100" height="100" mask="url(#m)"/>'],
    ['pattern', '<pattern id="p" width="1" height="1" patternUnits="userSpaceOnUse"><rect width="1" height="1"/></pattern><rect width="100" height="100" fill="url(#p)"/>'],
    ['clipPath', '<clipPath id="c"><rect width="10" height="10"/></clipPath><rect width="100" height="100" clip-path="url(#c)"/>'],
    ['symbol', '<symbol id="s"><rect width="10" height="10"/></symbol><use href="#s"/>'],
    ['marker', '<marker id="k"><rect width="1" height="1"/></marker><path d="M0 0L9 9" marker-end="url(#k)"/>'],
    ['an element in upper case', '<FILTER id="f"><feFlood/></FILTER><rect width="100" height="100"/>'],
    ['an element with a namespace prefix', '<svg:filter id="f"><svg:feFlood/></svg:filter><rect width="100" height="100"/>'],
    ['a style sheet', '<style>rect { filter: url(#f) }</style><rect width="100" height="100"/>'],
  ])('refuses %s, which the profile does not have', (_name, body) => {
    expect(refused(`${HEAD}${body}${TAIL}`)).toBe(true);
  });

  it('refuses a style attribute that asks for a filter', () => {
    expect(refused(`${HEAD}${FILTER}<rect width="100" height="100" style="fill:#f00; filter:url(#f)"/>${TAIL}`)).toBe(true);
    expect(refused(`${HEAD}<rect width="100" height="100" style="filter: url(#f)"/>${TAIL}`)).toBe(true);
  });

  it('refuses a <use> of something that leads back to it', () => {
    expect(refused(`${HEAD}<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>${TAIL}`)).toBe(true);
    expect(refused(`${HEAD}<g id="self"><rect width="1" height="1"/><use href="#self"/></g>${TAIL}`)).toBe(true);
  });

  it('refuses nested <use> written with xlink:href', () => {
    const body = '<defs><g id="a0"><rect width="1" height="1"/></g><g id="a1"><use xlink:href="#a0"/><use xlink:href="#a0"/></g></defs><use xlink:href="#a1"/>';
    expect(refused(`${HEAD}${body}${TAIL}`)).toBe(true);
  });

  // Control: what the profile allows still passes, a plain <use> of a shape included.
  it('still accepts shapes, gradients, groups and one plain <use>', () => {
    const body = '<defs><linearGradient id="g"><stop offset="0" stop-color="#06c"/><stop offset="1" stop-color="#0cf"/></linearGradient>'
      + '<circle id="dot" cx="5" cy="5" r="5"/></defs><g><rect width="100" height="100" fill="url(#g)"/><use href="#dot" x="40" y="40"/>'
      + '<path d="M10 10L90 90"/><text x="10" y="50">B</text></g>';
    expect(checkSvg(`${HEAD}${body}${TAIL}`, { strictProfile: true })).toBeNull();
  });
});

describe('drawing a logo', () => {
  it('gives up on a logo that draws for a long time, and file reads go on meanwhile', async () => {
    const events: string[] = [];
    const drawings = [1, 2, 3, 4].map((n) => Promise.race([
      rasterize(filteredUses(3)).then(() => 'drawn', () => 'gave up'),
      sleep(15_000).then(() => 'still running'),
    ]).then((outcome) => { events.push(`drawing ${n}`); return outcome; }));

    // Something else in the process that needs a thread from the shared pool.
    await sleep(300);
    const read = readFile(__filename).then(() => { events.push('file read'); });

    const outcomes = await Promise.all(drawings);
    await read;

    expect(outcomes).toEqual(['gave up', 'gave up', 'gave up', 'gave up']);
    expect(events[0]).toBe('file read');
  }, 180_000);

  // Control: an ordinary logo is drawn.
  it('still draws an ordinary logo', async () => {
    const png = await rasterize(`${HEAD}<rect width="100" height="100" fill="#06c"/>${TAIL}`);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });
});
