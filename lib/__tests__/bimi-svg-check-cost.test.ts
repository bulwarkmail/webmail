// checkSvg runs on the server's own thread for every sender logo it fetches, before anything is
// cached, and splitPem for every mark certificate. Their cost must grow in step with the input's size. The test compares an input with one four
// times as large: linear work takes about 4 times as long, quadratic work about 16 times. It asserts
// on that factor only, never on milliseconds.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkSvg, MAX_SELF_ASSERTED_BYTES } from '@/lib/bimi/svg';
import { splitPem } from '@/lib/bimi/certificate';

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
  'a style with a string that never closes': (n) => `${ROOT}<rect style="font-family:'${'/*'.repeat(n / 2)}"/></svg>`,
  'a style of many comments': (n) => `${ROOT}<rect style="fill:#06c${'/**/'.repeat(n / 4)}"/></svg>`,
  'a style of many escapes': (n) => `${ROOT}<rect style="font-family:${'\\41 '.repeat(n / 4)}"/></svg>`,
  'a style of many declarations': (n) => `${ROOT}<rect style="${'fill:#06c;'.repeat(n / 10)}"/></svg>`,
  'a style with a long list': (n) => `${ROOT}<rect style="stroke-dasharray:${'1,'.repeat(n / 2)}1"/></svg>`,
  'a style of functions that never close': (n) => `${ROOT}<rect style="fill:${'rgb('.repeat(n / 4)}"/></svg>`,
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

describe('splitPem on a mark certificate bundle up to the size limit', () => {
  // What the lookup reads from an evidence address at most (MAX_PEM_BYTES in lookup.ts).
  const cap = 128 * 1024;
  const BEGIN = '-----BEGIN CERTIFICATE-----\n';

  it('costs in step with the size: many BEGIN lines with no END', () => {
    const make = (n: number) => BEGIN.repeat(Math.floor(n / BEGIN.length));
    expect(Buffer.byteLength(make(cap))).toBeLessThanOrEqual(cap);
    const factor = growthFactor((n) => { splitPem(make(n)); }, 2000, cap);
    expect(factor).toBeLessThan(8);
  });

  // Control: a bundle still splits into its certificates.
  it('still reads every certificate of a bundle', () => {
    const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', 'bimi', `${name}.pem`), 'utf8');
    expect(splitPem(`${fixture('leaf')}\n${fixture('intermediate')}`)).toHaveLength(2);
  });
});
