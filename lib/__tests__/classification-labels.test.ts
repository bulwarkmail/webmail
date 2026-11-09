import { describe, expect, it } from 'vitest';
import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import {
  applyLabelPrefix,
  draftLabelChoice,
  draftLabelProperty,
  labelHeaderLines,
  labelHeaderProperties,
  parseSioLabelMarking,
  receivedLabel,
  sioLabelValue,
  textColorOn,
} from '@/lib/classification/labels';

// The headers a classification label writes (SIO-Label per RFC 7444 with
// RFC 2231 for non-ASCII markings, Sensitivity per RFC 2156, the admin's
// extra header), reading them back, and the subject prefix without doubling.

const generic = LABEL_PRESETS.find((p) => p.id === 'generic')!;
const german = LABEL_PRESETS.find((p) => p.id === 'german-public-sector')!;
const byId = (list: ClassificationLabel[], id: string) => list.find((l) => l.id === id)!;
const confidential = byId(generic.list, 'confidential');
const vsnfd = byId(german.list, 'vs-nfd');

describe('SIO-Label', () => {
  it('writes an ASCII marking quoted, with readable colours', () => {
    expect(sioLabelValue(confidential)).toBe(' marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706');
    expect(textColorOn('#1e3a8a')).toBe('#ffffff');
    expect(textColorOn('#fde68a')).toBe('#000000');
  });

  it('writes a non-ASCII marking with RFC 2231, never an encoded word, folded under 78 columns', () => {
    const value = sioLabelValue(vsnfd);
    expect(value).toContain("marking*=utf-8''VS-NUR%20F%C3%9CR%20DEN%20DIENSTGEBRAUCH;");
    expect(value).not.toContain('=?');
    for (const line of `SIO-Label:${value}`.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(parseSioLabelMarking(value)).toBe('VS-NUR FÜR DEN DIENSTGEBRAUCH');
  });

  it('continues a long encoded marking over several parameters and reads it back', () => {
    const long = { ...vsnfd, marking: 'ÄÖÜ äöü ß – sehr lange Kennzeichnung für einen Test der Fortsetzung' };
    const value = sioLabelValue(long);
    expect(value).toMatch(/marking\*0\*=utf-8''/);
    expect(value).toMatch(/marking\*1\*=/);
    expect(value).not.toMatch(/%[0-9A-F]?(;|\r|$)/);
    expect(parseSioLabelMarking(value)).toBe(long.marking);
  });

  it('reads the forms servers hand back: raw, refolded, a token, RFC 2047 inside quotes', () => {
    expect(parseSioLabelMarking(' marking="INTERNAL"; fgcolor=#ffffff; bgcolor=#2563eb')).toBe('INTERNAL');
    expect(parseSioLabelMarking(' marking="STRICTLY\r\n CONFIDENTIAL"; bgcolor=red')).toBe('STRICTLY CONFIDENTIAL');
    expect(parseSioLabelMarking('marking=PUBLIC;fgcolor=black')).toBe('PUBLIC');
    expect(parseSioLabelMarking(' marking="=?UTF-8?B?VlMtTlVSIEbDnFIgREVOIERJRU5TVEdFQlJBVUNI?="')).toBe('VS-NUR FÜR DEN DIENSTGEBRAUCH');
    expect(parseSioLabelMarking(' type=":ess"; label="MQYGASkCAQM="')).toBeNull();
    expect(parseSioLabelMarking(undefined)).toBeNull();
  });

  it('writes Sensitivity and the extra header only when the label sets them', () => {
    expect(labelHeaderProperties(confidential, 'X-Classification')).toEqual({
      // Without the leading space: the server writes "SIO-Label: " itself.
      'header:SIO-Label:asRaw': 'marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706',
      'header:Sensitivity:asText': 'Company-Confidential',
      'header:X-Classification:asText': 'Confidential',
    });
    expect(Object.keys(labelHeaderProperties(byId(generic.list, 'public'), ''))).toEqual(['header:SIO-Label:asRaw']);
    expect(labelHeaderLines(vsnfd, 'X-Classification')).toEqual([
      `SIO-Label:${sioLabelValue(vsnfd)}`,
      'Sensitivity: Company-Confidential',
      'X-Classification: VS-NfD',
    ]);
    expect(labelHeaderLines({ ...vsnfd, extraHeaderValue: 'Geheim für alle' }, 'X-Class')[2]).toMatch(/^X-Class: =\?UTF-8\?B\?/);
  });
});

describe('received labels', () => {
  const policy = { list: generic.list, defaultId: 'internal', required: false, extraHeader: 'X-Classification' };

  it('are matched by marking first, case and spacing aside', () => {
    expect(receivedLabel({ 'SIO-Label': ' marking="confidential "' }, policy)?.id).toBe('confidential');
    expect(receivedLabel({ 'sio-label': [' marking="PUBLIC"'] }, policy)?.id).toBe('public');
  });

  it('then by the extra header value', () => {
    expect(receivedLabel({ 'X-Classification': ' Strictly confidential' }, policy)?.id).toBe('strictly-confidential');
  });

  it('show nothing for an unknown marking or without labels', () => {
    expect(receivedLabel({ 'SIO-Label': ' marking="TOP SECRET"' }, policy)).toBeNull();
    expect(receivedLabel({ 'SIO-Label': ' marking="PUBLIC"' }, { ...policy, list: [] })).toBeNull();
  });
});

describe('the subject prefix', () => {
  const list = generic.list;
  const strictly = byId(list, 'strictly-confidential');

  it('is added once', () => {
    expect(applyLabelPrefix('Budget', confidential, list)).toBe('[Confidential] Budget');
    expect(applyLabelPrefix('[Confidential] Budget', confidential, list)).toBe('[Confidential] Budget');
  });

  it('is not doubled across reply and forward chains', () => {
    expect(applyLabelPrefix('Re: [Confidential] Budget', confidential, list)).toBe('[Confidential] Re: Budget');
    expect(applyLabelPrefix('AW: WG: [Confidential] Re: [Confidential] Budget', confidential, list)).toBe('[Confidential] AW: WG: Re: Budget');
  });

  it('changes with the label, and goes with no label', () => {
    expect(applyLabelPrefix('Re: [Confidential] Budget', strictly, list)).toBe('[Strictly confidential] Re: Budget');
    expect(applyLabelPrefix('[Confidential] Re: Budget', null, list)).toBe('Re: Budget');
    expect(applyLabelPrefix('Re: Budget', byId(list, 'internal'), list)).toBe('Re: Budget');
  });

  it('knows prefixes without brackets, like VS-NfD', () => {
    expect(applyLabelPrefix('AW: VS-NfD Lagebericht', vsnfd, german.list)).toBe('VS-NfD AW: Lagebericht');
    expect(applyLabelPrefix('VS-NfD: Lagebericht', vsnfd, german.list)).toBe('VS-NfD Lagebericht');
    // A word that only starts like a prefix stays.
    expect(applyLabelPrefix('VS-NfDx test', vsnfd, german.list)).toBe('VS-NfD VS-NfDx test');
  });
});

describe('drafts', () => {
  it('keep the pick, "none" and nothing apart', () => {
    expect(draftLabelProperty('confidential')).toEqual({ 'header:X-Bulwark-Label:asText': 'confidential' });
    expect(draftLabelProperty(null)).toEqual({ 'header:X-Bulwark-Label:asText': 'none' });
    expect(draftLabelProperty(undefined)).toEqual({});
    expect(draftLabelChoice({ 'X-Bulwark-Label': ' confidential' })).toBe('confidential');
    expect(draftLabelChoice({ 'x-bulwark-label': 'none' })).toBeNull();
    expect(draftLabelChoice({})).toBeUndefined();
  });
});
