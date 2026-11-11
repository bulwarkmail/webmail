// checkSvg runs on the server's own thread for every sender logo it fetches, before anything is
// cached. Its cost must grow in step with the logo's size. The test compares an input with one four
// times as large: linear work takes about 4 times as long, quadratic work about 16 times. It asserts
// on that factor only, never on milliseconds.
import { describe, expect, it } from 'vitest';
import { checkSvg, MAX_SELF_ASSERTED_BYTES } from '@/lib/bimi/svg';

/** Best of three runs, in ms. */
function best(run: () => void): number {
  let ms = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
}

/**
 * How many times longer the work takes for four times the input. The small size is doubled until
 * one run is long enough to measure or the cap is reached, so the answer does not depend on how
 * fast the machine is. The 1 ms added to both sides keeps two unmeasurably short runs at about 1.
 */
function growthFactor(run: (n: number) => void, start: number, cap: number): number {
  let n = start;
  while (n * 8 <= cap && best(() => run(n)) < 20) n *= 2;
  const small = best(() => run(n));
  const large = best(() => run(n * 4));
  return (large + 1) / (small + 1);
}

const ROOT = '<svg baseProfile="tiny-ps" viewBox="0 0 1 1">';

const cases: Record<string, (n: number) => string> = {
  'one long word inside the root tag': (n) => `<svg ${'a'.repeat(n)}>`,
  'a run of "<" with no ">"': (n) => `${ROOT}${'<'.repeat(n)}`,
  'a long title that never closes': (n) => `${ROOT}<title>${'a '.repeat(n / 2)}`,
  'many attributes with no value': (n) => `<svg ${'a '.repeat(n / 2)}>`,
  'a long run of spaces before "="': (n) => `<svg a${' '.repeat(n)}="1"><title>x</title></svg>`,
  'a comment that never closes': (n) => `${ROOT}<!--${'a-'.repeat(n / 2)}`,
  'a CDATA section that never closes': (n) => `${ROOT}<title><![CDATA[${'a]'.repeat(n / 2)}`,
  'many attributes on one tag': (n) => `${ROOT}<rect${Array.from({ length: Math.floor(n / 12) }, (_, i) => ` a${i}="1"`).join('')}/></svg>`,
};

describe('checkSvg on a self-published logo up to the size limit', () => {
  // The largest input stays inside the limit for a self-published logo.
  const cap = MAX_SELF_ASSERTED_BYTES - 100;

  for (const [name, make] of Object.entries(cases)) {
    it(`costs in step with the size: ${name}`, () => {
      expect(Buffer.byteLength(make(cap))).toBeLessThanOrEqual(MAX_SELF_ASSERTED_BYTES);
      const factor = growthFactor((n) => { checkSvg(make(n), { strictProfile: true }); }, 500, cap);
      expect(factor).toBeLessThan(8);
    });
  }

  // Control: an ordinary logo is still accepted.
  it('still accepts an ordinary Tiny PS logo', () => {
    const logo = '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"><title>Brand</title><rect width="100" height="100" fill="#06c"/></svg>';
    expect(checkSvg(logo, { strictProfile: true })).toBeNull();
  });
});
