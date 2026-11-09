import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import { usePolicyStore } from '@/stores/policy-store';
import { beginLabelTakeover, endLabelTakeover, labelRawSend, resetLabelTakeovers } from '../classification-raw';

// Labels on raw sends (api.jmap.sendRaw / submitRaw), the way S/MIME and PGP
// plugins send after a takeover: the takeover's label goes into the outer
// header block, matched by the token the request carries, or by identity
// when the plugin doesn't pass it (refused when that is ambiguous). Label
// headers a plugin wrote are always taken out, and a raw send outside a
// takeover gets the default or is refused when a label is required.

const generic = LABEL_PRESETS[0];
const labels = { list: generic.list, defaultId: 'internal', required: false, extraHeader: 'X-Classification' };
const label = (id: string) => generic.list.find((l) => l.id === id)!;

function useLabels(over: Partial<typeof labels> = {}) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: { ...labels, ...over } } } });
}

const raw = (head: string) => new TextEncoder().encode(`${head}\r\n\r\nContent-Type: application/pkcs7-mime\r\n\r\nSIGNED-BYTES\r\n`);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const headOf = (bytes: Uint8Array) => decode(bytes).split('\r\n\r\n')[0];
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error as Error; }
  return null;
};

afterEach(() => {
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  resetLabelTakeovers();
});

describe('a raw send during a takeover', () => {
  it('gets the label in the outer header block, the signed part untouched', () => {
    useLabels();
    const token = beginLabelTakeover(labels, label('confidential'), 'id-1')!;
    const out = decode(labelRawSend(raw('From: a@example.org\r\nSubject: [Confidential] Budget'), 'id-1', token));
    const [head, ...rest] = out.split('\r\n\r\n');
    expect(head).toContain('SIO-Label: marking="CONFIDENTIAL"');
    expect(head).toContain('Sensitivity: Company-Confidential');
    expect(head).toContain('X-Classification: Confidential');
    expect(rest.join('\r\n\r\n')).toBe('Content-Type: application/pkcs7-mime\r\n\r\nSIGNED-BYTES\r\n');
    endLabelTakeover(token);
  });

  it('matches two takeovers at once by their tokens, whatever the subjects are', () => {
    useLabels();
    const first = beginLabelTakeover(labels, label('public'), 'id-1')!;
    const second = beginLabelTakeover(labels, label('confidential'), 'id-1')!;
    // Subjects as plugins write them: raw UTF-8 and an encoded word.
    const a = headOf(labelRawSend(raw('Subject: Grüße aus Köln'), 'id-1', second));
    const b = headOf(labelRawSend(raw('Subject: =?UTF-8?B?R3LDvMOfZQ==?='), 'id-1', first));
    expect(a).toContain('marking="CONFIDENTIAL"');
    expect(a).toContain('Subject: Grüße aus Köln');
    expect(b).toContain('marking="PUBLIC"');
  });

  it('matches a plugin that passes no token by its identity, and refuses when two are open', () => {
    useLabels();
    const one = beginLabelTakeover(labels, label('confidential'), 'acct-2::id-1')!;
    // The request's identity carries the other account's prefix; the plugin passes the raw id.
    expect(headOf(labelRawSend(raw('Subject: Grüße'), 'id-1'))).toContain('marking="CONFIDENTIAL"');
    beginLabelTakeover(labels, label('public'), 'id-1');
    expect(refusal(() => labelRawSend(raw('Subject: Grüße'), 'id-1'))?.name).toBe('RawSendLabelError');
    endLabelTakeover(one);
  });

  it('takes out label headers the plugin wrote, also for "no label"', () => {
    useLabels();
    const token = beginLabelTakeover(labels, null, 'id-1')!;
    const out = headOf(labelRawSend(raw('Subject: x\r\nSIO-Label: marking="FORGED";\r\n bgcolor=red\r\nSensitivity: Private\r\nX-Classification: Secret'), 'id-1', token));
    expect(out).toBe('Subject: x');
  });

  it('refuses a token that is no longer open', () => {
    useLabels();
    const token = beginLabelTakeover(labels, label('public'), 'id-1')!;
    endLabelTakeover(token);
    expect(refusal(() => labelRawSend(raw('Subject: x'), 'id-1', token))?.name).toBe('RawSendLabelError');
  });
});

describe('a raw send outside any takeover', () => {
  it('gets the default label and loses forged ones', () => {
    useLabels();
    const out = headOf(labelRawSend(raw('Subject: x\r\nSIO-Label: marking="PUBLIC"'), 'id-1'));
    expect(out).toContain('marking="INTERNAL"');
    expect(out).not.toContain('PUBLIC');
  });

  it('is refused when a label is required', () => {
    useLabels({ required: true, defaultId: '' });
    const error = refusal(() => labelRawSend(raw('Subject: x'), 'id-1'));
    expect(error?.name).toBe('RawSendLabelError');
    expect(error?.message).toContain('requires a classification label');
  });

  it('is left alone while the organisation has no labels', () => {
    const bytes = raw('Subject: x\r\nSensitivity: Private');
    expect(labelRawSend(bytes, 'id-1')).toBe(bytes);
  });
});

describe('the extra header on raw sends', () => {
  it('is folded, non-ASCII as encoded words of at most 75 characters', () => {
    useLabels();
    const long = { ...label('confidential'), extraHeaderValue: 'Vertraulich – nur für den internen Gebrauch der Abteilung Öffentlichkeitsarbeit und Presse' };
    const token = beginLabelTakeover(labels, long, 'id-1')!;
    const head = headOf(labelRawSend(raw('Subject: x'), 'id-1', token));
    const extra = head.slice(head.indexOf('X-Classification:')).split('\r\n').filter((line, i) => i === 0 || line.startsWith(' '));
    expect(extra.length).toBeGreaterThan(1);
    for (const line of extra) expect(line.length).toBeLessThanOrEqual(78);
    for (const word of head.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = (head.match(/=\?UTF-8\?B\?([^?]*)\?=/g) ?? [])
      .map((w) => Buffer.from(w.slice(10, -2), 'base64'));
    expect(Buffer.concat(decoded).toString('utf8')).toBe(long.extraHeaderValue);
  });
});
