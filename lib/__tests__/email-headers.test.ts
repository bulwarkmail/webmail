import { describe, it, expect } from 'vitest';
import {
  parseAuthenticationResults,
  parseSpamScore,
  parseReceivedHeaders,
  formatBytes,
  getSecurityStatus,
  parseSpamLLM,
  extractListHeaders,
  isAuthenticationSpoofed,
} from '../email-headers';

describe('parseAuthenticationResults', () => {
  it('parses SPF pass with domain', () => {
    const result = parseAuthenticationResults('spf=pass smtp.mailfrom=example.com');
    expect(result.spf).toEqual({ result: 'pass', domain: 'example.com' });
  });

  it('parses DKIM pass with domain and selector', () => {
    const result = parseAuthenticationResults('dkim=pass header.d=example.com header.s=selector1');
    expect(result.dkim).toEqual({ result: 'pass', domain: 'example.com', selector: 'selector1' });
  });

  it('parses DMARC pass with domain', () => {
    const result = parseAuthenticationResults('dmarc=pass header.from=example.com');
    expect(result.dmarc).toEqual({ result: 'pass', domain: 'example.com', policy: undefined });
  });

  it('parses all three together separated by semicolons', () => {
    const header = 'spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com';
    const result = parseAuthenticationResults(header);
    expect(result.spf?.result).toBe('pass');
    expect(result.dkim?.result).toBe('pass');
    expect(result.dmarc?.result).toBe('pass');
  });

  it('parses failure results', () => {
    expect(parseAuthenticationResults('spf=fail smtp.mailfrom=bad.com').spf?.result).toBe('fail');
    expect(parseAuthenticationResults('dkim=fail header.d=bad.com').dkim?.result).toBe('fail');
    expect(parseAuthenticationResults('dmarc=fail header.from=bad.com').dmarc?.result).toBe('fail');
  });

  it('returns empty object for unrecognized header', () => {
    expect(parseAuthenticationResults('garbage header value')).toEqual({});
  });

  it('parses iprev with IP address', () => {
    const result = parseAuthenticationResults('iprev=pass policy.iprev=192.168.1.1');
    expect(result.iprev).toEqual({ result: 'pass', ip: '192.168.1.1' });
  });

  it('parses SPF softfail', () => {
    const result = parseAuthenticationResults('spf=softfail smtp.mailfrom=example.com');
    expect(result.spf?.result).toBe('softfail');
  });

  it('surfaces the most severe result when multiple SPF identities exist', () => {
    // HELO temperror, MAIL FROM fail — the harder fail must be the headline.
    const header =
      'mx.example.com; spf=temperror (mx: dns timeout) smtp.helo=mail.spoof.com; spf=fail (mx: not authorized) smtp.mailfrom=victim.com';
    const result = parseAuthenticationResults(header);
    expect(result.spf?.result).toBe('fail');
    expect(result.spf?.domain).toBe('victim.com');
  });

  it('exposes all SPF results when more than one identity is evaluated', () => {
    const header =
      'spf=temperror smtp.helo=mail.spoof.com; spf=fail smtp.mailfrom=victim.com';
    const result = parseAuthenticationResults(header);
    expect(result.spf?.all).toEqual([
      { result: 'temperror', identity: 'helo', domain: 'mail.spoof.com' },
      { result: 'fail', identity: 'mailfrom', domain: 'victim.com' },
    ]);
  });

  it('does not set `all` for a single SPF result', () => {
    const result = parseAuthenticationResults('spf=pass smtp.mailfrom=example.com');
    expect(result.spf?.all).toBeUndefined();
  });

  it('prefers the MAIL FROM identity when severities tie', () => {
    const header = 'spf=pass smtp.helo=mail.example.com; spf=pass smtp.mailfrom=example.com';
    const result = parseAuthenticationResults(header);
    expect(result.spf?.domain).toBe('example.com');
  });
});

describe('isAuthenticationSpoofed', () => {
  it('returns false when no auth results are present', () => {
    expect(isAuthenticationSpoofed(undefined)).toBe(false);
    expect(isAuthenticationSpoofed({})).toBe(false);
  });

  it('flags a DMARC fail as spoofed', () => {
    expect(isAuthenticationSpoofed({ dmarc: { result: 'fail' } })).toBe(true);
  });

  it('flags a hard SPF fail without a passing DKIM as spoofed', () => {
    expect(isAuthenticationSpoofed({ spf: { result: 'fail' } })).toBe(true);
    expect(
      isAuthenticationSpoofed({ spf: { result: 'fail' }, dkim: { result: 'fail' } })
    ).toBe(true);
  });

  it('does not flag an SPF fail rescued by a passing DKIM', () => {
    expect(
      isAuthenticationSpoofed({ spf: { result: 'fail' }, dkim: { result: 'pass' } })
    ).toBe(false);
  });

  it('does not flag passing or ambiguous results', () => {
    expect(isAuthenticationSpoofed({ spf: { result: 'pass' }, dmarc: { result: 'pass' } })).toBe(false);
    expect(isAuthenticationSpoofed({ spf: { result: 'softfail' } })).toBe(false);
    expect(isAuthenticationSpoofed({ spf: { result: 'temperror' } })).toBe(false);
  });
});

describe('parseSpamScore', () => {
  it('parses X-Spam-Status "No" format', () => {
    expect(parseSpamScore('No, score=-0.25')).toEqual({ status: 'no', score: -0.25 });
  });

  it('parses X-Spam-Status "Yes" format', () => {
    expect(parseSpamScore('Yes, score=8.5')).toEqual({ status: 'yes', score: 8.5 });
  });

  it('extracts plain score and classifies as ham', () => {
    expect(parseSpamScore('score=3.2')).toEqual({ score: 3.2, status: 'ham' });
  });

  it('extracts plain score and classifies as spam when above threshold', () => {
    expect(parseSpamScore('score=6.0')).toEqual({ score: 6.0, status: 'spam' });
  });

  it('returns null for unrecognized format', () => {
    expect(parseSpamScore('nothing useful here')).toBeNull();
  });
});

describe('parseReceivedHeaders', () => {
  it('parses a single received header', () => {
    const headers = ['from mail.example.com by mx.example.com with SMTP id abc123; Mon, 15 Jan 2024 10:00:00 +0000'];
    const result = parseReceivedHeaders(headers);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe('mail.example.com');
    expect(result[0].by).toBe('mx.example.com');
    expect(result[0].protocol).toBe('SMTP');
    expect(result[0].id).toBe('abc123');
    expect(result[0].timestamp).toBe('Mon, 15 Jan 2024 10:00:00 +0000');
  });

  it('handles missing fields gracefully', () => {
    const result = parseReceivedHeaders(['from sender.example.com']);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe('sender.example.com');
    expect(result[0].by).toBe('unknown');
  });

  it('returns empty array for empty input', () => {
    expect(parseReceivedHeaders([])).toEqual([]);
  });

  it('skips headers with no from or by', () => {
    expect(parseReceivedHeaders(['random text without routing info'])).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512.0 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });
});

describe('getSecurityStatus', () => {
  it('returns green for pass', () => {
    const status = getSecurityStatus('pass');
    expect(status.icon).toBe('check');
    expect(status.color).toContain('green');
    expect(status.borderColor).toContain('green');
  });

  it('returns red for fail', () => {
    const status = getSecurityStatus('fail');
    expect(status.icon).toBe('x');
    expect(status.color).toContain('red');
  });

  it('returns red for permerror', () => {
    const status = getSecurityStatus('permerror');
    expect(status.icon).toBe('x');
    expect(status.color).toContain('red');
  });

  it('returns a warning color for softfail', () => {
    const status = getSecurityStatus('softfail');
    expect(status.icon).toBe('alert');
    expect(status.color).toContain('warning');
  });

  it('returns amber for neutral and temperror', () => {
    expect(getSecurityStatus('neutral').icon).toBe('alert');
    expect(getSecurityStatus('temperror').icon).toBe('alert');
  });

  it('returns gray for undefined', () => {
    const status = getSecurityStatus(undefined);
    expect(status.icon).toBe('minus');
    expect(status.color).toContain('gray');
  });
});

describe('parseSpamLLM', () => {
  it('parses LEGITIMATE verdict', () => {
    expect(parseSpamLLM('LEGITIMATE (This is a normal email)')).toEqual({
      verdict: 'LEGITIMATE',
      explanation: 'This is a normal email',
    });
  });

  it('parses SPAM verdict', () => {
    expect(parseSpamLLM('SPAM (Unsolicited bulk message)')).toEqual({
      verdict: 'SPAM',
      explanation: 'Unsolicited bulk message',
    });
  });

  it('parses SUSPICIOUS verdict', () => {
    expect(parseSpamLLM('SUSPICIOUS (Possible phishing attempt)')).toEqual({
      verdict: 'SUSPICIOUS',
      explanation: 'Possible phishing attempt',
    });
  });

  it('is case-insensitive for verdict keyword', () => {
    expect(parseSpamLLM('legitimate (test)')).toEqual({
      verdict: 'LEGITIMATE',
      explanation: 'test',
    });
  });

  it('returns null for unrecognized format', () => {
    expect(parseSpamLLM('some random header')).toBeNull();
    expect(parseSpamLLM('')).toBeNull();
  });
});

describe('extractListHeaders', () => {
  it('extracts List-Id', () => {
    const result = extractListHeaders({ 'List-Id': 'My Newsletter <list.example.com>' });
    expect(result.listId).toBe('My Newsletter <list.example.com>');
  });

  it('extracts List-Unsubscribe with HTTP URL', () => {
    const result = extractListHeaders({
      'List-Unsubscribe': '<https://example.com/unsubscribe?id=123>',
    });
    expect(result.listUnsubscribe?.http).toBe('https://example.com/unsubscribe?id=123');
    expect(result.listUnsubscribe?.preferred).toBe('http');
  });

  it('extracts List-Unsubscribe with both HTTP and mailto', () => {
    const result = extractListHeaders({
      'List-Unsubscribe': '<https://example.com/unsub>, <mailto:unsub@example.com>',
    });
    expect(result.listUnsubscribe?.http).toBe('https://example.com/unsub');
    expect(result.listUnsubscribe?.mailto).toBe('mailto:unsub@example.com');
    expect(result.listUnsubscribe?.preferred).toBe('http');
  });

  it('handles array header values', () => {
    const result = extractListHeaders({
      'List-Id': ['Newsletter <list.example.com>', 'fallback'],
    });
    expect(result.listId).toBe('Newsletter <list.example.com>');
  });

  it('returns empty object when no list headers present', () => {
    expect(extractListHeaders({})).toEqual({});
    expect(extractListHeaders({ 'Subject': 'hello' })).toEqual({});
  });

  it('extracts List-Help and List-Post', () => {
    const result = extractListHeaders({
      'List-Help': '<mailto:help@example.com>',
      'List-Post': '<mailto:post@example.com>',
    });
    expect(result.listHelp).toBe('<mailto:help@example.com>');
    expect(result.listPost).toBe('<mailto:post@example.com>');
  });
});
