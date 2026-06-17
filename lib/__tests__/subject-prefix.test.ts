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

  it('strips the Outlook [N] and Eudora *N counters', () => {
    expect(stripSubjectPrefixes('Re[2]: foo')).toBe('foo');
    expect(stripSubjectPrefixes('Re*3: foo')).toBe('foo');
  });

  it('is case-insensitive and idempotent', () => {
    expect(stripSubjectPrefixes('RE: Re: foo')).toBe('foo');
    expect(stripSubjectPrefixes(stripSubjectPrefixes('RE: Re: foo'))).toBe('foo');
  });

  it('strips a Cyrillic token and an ASCII-colon Chinese token', () => {
    expect(stripSubjectPrefixes('Ответ: foo')).toBe('foo');
    expect(stripSubjectPrefixes('回复: foo')).toBe('foo');
  });

  it('strips a token followed by a full-width colon (CJK clients)', () => {
    expect(stripSubjectPrefixes('回复：foo')).toBe('foo');
    expect(stripSubjectPrefixes('回覆：foo')).toBe('foo');
    expect(stripSubjectPrefixes('Re：foo')).toBe('foo');
  });

  it('still does not strip a bare single-letter "R:"', () => {
    expect(stripSubjectPrefixes('R: budget 2024')).toBe('R: budget 2024');
  });

  it('returns "" for empty / null / undefined and leaves clean subjects alone', () => {
    expect(stripSubjectPrefixes('')).toBe('');
    expect(stripSubjectPrefixes(null)).toBe('');
    expect(stripSubjectPrefixes(undefined)).toBe('');
    expect(stripSubjectPrefixes('foo')).toBe('foo');
  });
});

describe('buildReplySubject / buildForwardSubject', () => {
  it('replaces a prefix chain (incl. a full-width colon) with the given prefix', () => {
    expect(buildReplySubject('回复：foo', 'Re:')).toBe('Re: foo');
    expect(buildForwardSubject('Re: foo', 'Fwd:')).toBe('Fwd: foo');
  });

  it('prepends to a clean subject and returns the bare prefix for empty input', () => {
    expect(buildReplySubject('foo', 'AW:')).toBe('AW: foo');
    expect(buildReplySubject('', 'AW:')).toBe('AW:');
  });
});
