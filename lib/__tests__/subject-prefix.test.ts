import { describe, it, expect } from 'vitest';
import {
  stripSubjectPrefixes,
  buildReplySubject,
  buildForwardSubject,
} from '@/lib/subject-prefix';

describe('stripSubjectPrefixes', () => {
  it('strips a chain of mixed-language prefixes', () => {
    expect(stripSubjectPrefixes('Re: AW: WG: foo')).toBe('foo');
  });

  it('strips the Outlook [N] counter and Eudora *N counter', () => {
    expect(stripSubjectPrefixes('Re[2]: foo')).toBe('foo');
    expect(stripSubjectPrefixes('Re*3: foo')).toBe('foo');
    expect(stripSubjectPrefixes('Re*: foo')).toBe('foo');
  });

  it('is case-insensitive and idempotent', () => {
    expect(stripSubjectPrefixes('RE: Re: foo')).toBe('foo');
    expect(stripSubjectPrefixes(stripSubjectPrefixes('RE: Re: foo'))).toBe('foo');
  });

  it('strips a Cyrillic reply token', () => {
    expect(stripSubjectPrefixes('Ответ: foo')).toBe('foo');
  });

  it('strips a Chinese token followed by an ASCII colon', () => {
    expect(stripSubjectPrefixes('回复: foo')).toBe('foo');
  });

  it('CHARACTERISATION: does NOT strip a token followed by a full-width colon', () => {
    // The colon in the regex is ASCII ":"; a full-width "：" (U+FF1A), as some
    // CJK mail clients emit, is left untouched. Likely a bug — see follow-ups.
    expect(stripSubjectPrefixes('回复：foo')).toBe('回复：foo');
  });

  it('does NOT strip a bare single-letter "R:" (would eat real subjects)', () => {
    expect(stripSubjectPrefixes('R: budget 2024')).toBe('R: budget 2024');
  });

  it('returns "" for empty / null / undefined', () => {
    expect(stripSubjectPrefixes('')).toBe('');
    expect(stripSubjectPrefixes(null)).toBe('');
    expect(stripSubjectPrefixes(undefined)).toBe('');
  });

  it('leaves a prefix-free subject untouched', () => {
    expect(stripSubjectPrefixes('foo')).toBe('foo');
  });
});

describe('buildReplySubject / buildForwardSubject', () => {
  it('replaces an existing prefix chain with the given prefix', () => {
    expect(buildReplySubject('AW: WG: foo', 'Re:')).toBe('Re: foo');
    expect(buildForwardSubject('Re: foo', 'Fwd:')).toBe('Fwd: foo');
  });

  it('prepends the prefix to a prefix-free subject', () => {
    expect(buildReplySubject('foo', 'AW:')).toBe('AW: foo');
  });

  it('returns just the bare prefix for an empty subject', () => {
    expect(buildReplySubject('', 'AW:')).toBe('AW:');
    expect(buildForwardSubject(null, 'Fwd:')).toBe('Fwd:');
  });
});
