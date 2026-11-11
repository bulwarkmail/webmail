// getStructuredMailTrust runs for every opened message whose sender the server verified. Its
// "was this forwarded?" check reads the whole body, so its cost must grow in step with the body's
// size. Each case compares a body with one four times as large: linear work takes about 4 times as
// long, quadratic work about 16 times. The test asserts on that factor only, never on milliseconds.
import { describe, expect, it } from 'vitest';
import { getStructuredMailTrust } from '../structured-mail/trust';
import type { Email } from '../jmap/types';

/** A message the receiving server tied to its From domain, as any sender with a domain of their own gets. */
const verified = (html: string, text?: string) => ({
  from: [{ name: 'Shop', email: 'orders@shop.example' }],
  subject: 'Your order',
  authenticationResults: { dmarc: { result: 'pass', domain: 'shop.example' }, dkim: { result: 'pass', domain: 'shop.example' } },
  authenticationResultsOnReceipt: true,
  htmlBody: [{ partId: 'h', type: 'text/html' }],
  textBody: text === undefined ? [] : [{ partId: 't', type: 'text/plain' }],
  bodyValues: { h: { value: html }, ...(text === undefined ? {} : { t: { value: text } }) },
}) as unknown as Email;

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

/** `n` is the number of repeats; the largest body any case builds is about 250 KB. */
const CAP = 32_000;

describe('the cost of the booking card trust check', () => {
  it.each<[string, (n: number) => string]>([
    ['a run of <br>', (n) => '<p>Your order</p>' + '<br>'.repeat(n)],
    ['a run of <br> with CR LF line ends', (n) => '<p>Your order</p>' + '<br>\r\n'.repeat(n)],
    ['a run of dashes', (n) => '<p>Your order</p><p>' + '-'.repeat(n) + '</p>'],
    ['a run of "<"', (n) => '<p>Your order</p>' + '<'.repeat(n)],
    ['a run of unclosed <script', (n) => '<p>Your order</p>' + '<script'.repeat(n)],
    ['a run of unclosed <style', (n) => '<p>Your order</p>' + '<style'.repeat(n)],
    ['a run of <script> that never closes', (n) => '<p>Your order</p>' + '<script>'.repeat(n)],
    ['a run of <!-- that never closes', (n) => '<p>Your order</p>' + '<!--'.repeat(n)],
    ['a run of &nbsp;', (n) => '<p>Your order</p><p>' + '&nbsp;'.repeat(n) + '</p>'],
    ['a long single line', (n) => '<p>Your order ' + 'word - '.repeat(n) + '</p>'],
    ['blank lines with CR LF line ends', (n) => '<p>Your order</p>' + '\r\n'.repeat(n)],
  ])('grows in step with an HTML body: %s', (_name, make) => {
    expect(growthFactor((n) => { getStructuredMailTrust(verified(make(n))); }, 500, CAP)).toBeLessThan(8);
  });

  it.each<[string, (n: number) => string]>([
    ['blank lines', (n) => '\n'.repeat(n)],
    ['blank lines with CR LF line ends', (n) => '\r\n'.repeat(n)],
    ['lines of spaces with CR LF line ends', (n) => '   \r\n'.repeat(n)],
    ['dashes', (n) => '-'.repeat(n)],
    ['dashes on lines with CR LF line ends', (n) => '------\r\n'.repeat(n)],
    ['spaces before a forward marker that never comes', (n) => ('-- ' + ' '.repeat(200)).repeat(Math.ceil(n / 40))],
    ['a long single line', (n) => 'From: x Sent: y '.repeat(n)],
    ['From and Sent lines without a Subject', (n) => 'From: a\nSent: b\n'.repeat(n)],
  ])('grows in step with a text part: %s', (_name, make) => {
    expect(growthFactor((n) => { getStructuredMailTrust(verified('<p>Your order</p>', make(n))); }, 500, CAP)).toBeLessThan(8);
  });

  // Controls: the check still does its job.
  it('still tells a forwarded booking from the original', () => {
    expect(getStructuredMailTrust(verified('<p>Your order</p>')).trusted).toBe(true);
    const forwarded = getStructuredMailTrust(verified('<p>---------- Forwarded message ----------</p><p>Your order</p>'));
    expect(forwarded).toEqual({ trusted: false, reason: 'forwarded' });
    const outlook = getStructuredMailTrust(verified('<p>x</p>', 'From: A\nSent: Monday\nTo: B\nSubject: Your order\n\nbody'));
    expect(outlook).toEqual({ trusted: false, reason: 'forwarded' });
  });

  it('still finds a forward marker that sits below a few lines of opening text', () => {
    const opening = '<p>Dear customer,</p>'.repeat(40);
    const forwarded = getStructuredMailTrust(verified(`${opening}<p>---------- Forwarded message ----------</p><p>Your order</p>`));
    expect(forwarded).toEqual({ trusted: false, reason: 'forwarded' });
  });

  it('still finds the markers each mail client writes, with any line ends', () => {
    const cases: [string, string | undefined][] = [
      ['<p>x</p>', '-----Original Message-----\r\nFrom: A\r\n'],
      ['<p>x</p>', 'Hi,\r\n\r\nBegin forwarded message:\r\n\r\nFrom: A'],
      ['<div>See below<br>-------- Weitergeleitete Nachricht --------<br>Betreff: x</div>', undefined],
      ['<div>See below<br>---------- Forwarded&nbsp;message ---------<br></div>', undefined],
      ['<p>x</p>', 'FYI\r\n\r\nVon: Shop\r\nGesendet: Freitag\r\nAn: Erika\r\nCc: Max\r\n\r\nBetreff: Ihre Bestellung\r\n'],
      ['<style>p{}</style><p>Hi</p><p>----- Message transféré -----</p>', undefined],
    ];
    for (const [html, text] of cases) {
      expect(getStructuredMailTrust(verified(html, text))).toEqual({ trusted: false, reason: 'forwarded' });
    }
  });

  it('still reads a forward marker behind a long style block and after an unclosed script', () => {
    const style = `<style>${'p.x{margin:0}'.repeat(4000)}</style>`;
    expect(getStructuredMailTrust(verified(`${style}<p>---------- Forwarded message ----------</p>`)).trusted).toBe(false);
    // An unclosed script runs to the end of the part, as a browser reads it.
    expect(getStructuredMailTrust(verified('<p>Your order</p><script>---------- Forwarded message ----------')).trusted).toBe(true);
  });

  it('does not take a marker inside other text for a separator line', () => {
    expect(getStructuredMailTrust(verified('<p>Your original message was received.</p>', 'Your forwarded message is on its way.')).trusted).toBe(true);
    expect(getStructuredMailTrust(verified('<p>x</p>', 'From: Frankfurt\nTo: New York\nDate: 1 Dec')).trusted).toBe(true);
  });
});
