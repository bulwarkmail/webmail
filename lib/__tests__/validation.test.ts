import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  validateEmailList,
  getEmailValidationError,
  isValidUnsubscribeUrl,
  parseUnsubscribeUrls,
  parseMailtoUrl,
} from '../validation';

describe('validation', () => {
  describe('isValidEmail', () => {
    it('should accept valid basic emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('john.doe@company.co.uk')).toBe(true);
      expect(isValidEmail('test_user@subdomain.example.com')).toBe(true);
    });

    it('should accept emails with plus addressing', () => {
      expect(isValidEmail('user+tag@example.com')).toBe(true);
      expect(isValidEmail('user+shopping@example.com')).toBe(true);
    });

    it('should accept various valid formats', () => {
      expect(isValidEmail('a@b.co')).toBe(true);
      expect(isValidEmail('user123@test-domain.com')).toBe(true);
      expect(isValidEmail('first.last+tag@example.co.uk')).toBe(true);
    });

    it('should reject emails without @ symbol', () => {
      expect(isValidEmail('userexample.com')).toBe(false);
      expect(isValidEmail('user')).toBe(false);
    });

    it('should reject emails without domain', () => {
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
    });

    it('should reject header injection attempts', () => {
      expect(isValidEmail('test\r\nBcc:evil@example.com')).toBe(false);
      expect(isValidEmail('test\rBcc:evil@example.com')).toBe(false);
      expect(isValidEmail('test\nBcc:evil@example.com')).toBe(false);
    });

    it('should reject emails with dangerous characters', () => {
      expect(isValidEmail('test<script>@example.com')).toBe(false);
      expect(isValidEmail('test>evil@example.com')).toBe(false);
      expect(isValidEmail('test@evil>.com')).toBe(false);
    });

    it('should reject overly long emails', () => {
      const longLocal = 'a'.repeat(256);
      expect(isValidEmail(`${longLocal}@example.com`)).toBe(false);
    });

    it('should reject emails with local part > 64 chars', () => {
      const longLocal = 'a'.repeat(65);
      expect(isValidEmail(`${longLocal}@example.com`)).toBe(false);
    });

    it('should reject emails with domain > 255 chars', () => {
      const longDomain = 'a'.repeat(256) + '.com';
      expect(isValidEmail(`user@${longDomain}`)).toBe(false);
    });

    it('should reject domains starting or ending with dot', () => {
      expect(isValidEmail('user@.example.com')).toBe(false);
      expect(isValidEmail('user@example.com.')).toBe(false);
    });

    it('should reject domains with consecutive dots', () => {
      expect(isValidEmail('user@example..com')).toBe(false);
      expect(isValidEmail('user@sub..domain.com')).toBe(false);
    });

    it('should reject empty or null input', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('   ')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isValidEmail('user@localhost')).toBe(true); // Valid per RFC
      expect(isValidEmail('user@192.168.1.1')).toBe(true); // IP address domain
    });
  });

  describe('validateEmailList', () => {
    it('should validate single valid email', () => {
      const result = validateEmailList('user@example.com');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });

    it('should validate multiple valid emails', () => {
      const result = validateEmailList('user1@example.com, user2@test.com, user3@domain.co.uk');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });

    it('should handle whitespace around emails', () => {
      const result = validateEmailList('  user1@example.com  ,  user2@test.com  ');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });

    it('should reject list with one invalid email', () => {
      const result = validateEmailList('user1@example.com, invalid-email, user3@domain.com');
      expect(result.valid).toBe(false);
      expect(result.invalidEmails).toEqual(['invalid-email']);
    });

    it('should identify all invalid emails', () => {
      const result = validateEmailList('user1@example.com, bad1, user2@test.com, bad2@');
      expect(result.valid).toBe(false);
      expect(result.invalidEmails).toContain('bad1');
      expect(result.invalidEmails).toContain('bad2@');
      expect(result.invalidEmails).toHaveLength(2);
    });

    it('should handle empty string', () => {
      const result = validateEmailList('');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });

    it('should handle whitespace-only string', () => {
      const result = validateEmailList('   ');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });

    it('should filter out empty entries from commas', () => {
      const result = validateEmailList('user1@example.com,,user2@test.com,');
      expect(result.valid).toBe(true);
      expect(result.invalidEmails).toEqual([]);
    });
  });

  describe('getEmailValidationError', () => {
    it('should return null for valid email', () => {
      expect(getEmailValidationError('user@example.com')).toBeNull();
      expect(getEmailValidationError('user+tag@example.com')).toBeNull();
    });

    it('should return error for empty email', () => {
      const error = getEmailValidationError('');
      expect(error).not.toBeNull();
      expect(error).toContain('required');
    });

    it('should return error for whitespace-only email', () => {
      const error = getEmailValidationError('   ');
      expect(error).not.toBeNull();
      expect(error).toContain('required');
    });

    it('should return error for overly long email', () => {
      const longEmail = 'a'.repeat(256) + '@example.com';
      const error = getEmailValidationError(longEmail);
      expect(error).not.toBeNull();
      expect(error).toContain('too long');
      expect(error).toContain('254');
    });

    it('should return error for dangerous characters', () => {
      const error = getEmailValidationError('test\r\nBcc:evil@example.com');
      expect(error).not.toBeNull();
      expect(error).toContain('invalid characters');
    });

    it('should return error for invalid format', () => {
      const error = getEmailValidationError('not-an-email');
      expect(error).not.toBeNull();
      expect(error).toContain('valid email');
    });

    it('should provide user-friendly messages', () => {
      const error1 = getEmailValidationError('test@');
      const error2 = getEmailValidationError('@example.com');
      const error3 = getEmailValidationError('no-at-sign');

      expect(error1).toContain('valid');
      expect(error2).toContain('valid');
      expect(error3).toContain('valid');
    });
  });

  describe('isValidUnsubscribeUrl', () => {
    describe('HTTP/HTTPS URLs', () => {
      it('should accept valid HTTP URLs', () => {
        expect(isValidUnsubscribeUrl('http://example.com/unsubscribe')).toBe(true);
        expect(isValidUnsubscribeUrl('http://newsletter.example.com/unsub?id=123')).toBe(true);
      });

      it('should accept valid HTTPS URLs', () => {
        expect(isValidUnsubscribeUrl('https://example.com/unsubscribe')).toBe(true);
        expect(isValidUnsubscribeUrl('https://example.com/unsub?token=abc123')).toBe(true);
        expect(isValidUnsubscribeUrl('https://sub.domain.com/unsubscribe')).toBe(true);
      });

      it('should accept URLs with paths and query params', () => {
        expect(isValidUnsubscribeUrl('https://example.com/path/to/unsub?id=123&token=abc')).toBe(true);
        expect(isValidUnsubscribeUrl('http://example.com/unsub#section')).toBe(true);
      });
    });

    describe('mailto URLs', () => {
      it('should accept valid mailto URLs', () => {
        expect(isValidUnsubscribeUrl('mailto:unsubscribe@example.com')).toBe(true);
        expect(isValidUnsubscribeUrl('mailto:unsub@newsletter.com')).toBe(true);
      });

      it('should accept mailto with query params', () => {
        expect(isValidUnsubscribeUrl('mailto:unsub@example.com?subject=Unsubscribe')).toBe(true);
        expect(isValidUnsubscribeUrl('mailto:unsub@example.com?subject=Remove&body=Please%20remove')).toBe(true);
      });

      it('should reject mailto with invalid email', () => {
        expect(isValidUnsubscribeUrl('mailto:invalid-email')).toBe(false);
        expect(isValidUnsubscribeUrl('mailto:@example.com')).toBe(false);
        expect(isValidUnsubscribeUrl('mailto:user@')).toBe(false);
      });
    });

    describe('XSS attack vectors', () => {
      it('should reject javascript: protocol', () => {
        expect(isValidUnsubscribeUrl('javascript:alert(1)')).toBe(false);
        expect(isValidUnsubscribeUrl('javascript:alert(document.cookie)')).toBe(false);
        expect(isValidUnsubscribeUrl('javascript:void(0)')).toBe(false);
      });

      it('should reject data: protocol', () => {
        expect(isValidUnsubscribeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isValidUnsubscribeUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
      });

      it('should reject file: protocol', () => {
        expect(isValidUnsubscribeUrl('file:///etc/passwd')).toBe(false);
        expect(isValidUnsubscribeUrl('file://C:/Windows/System32/config')).toBe(false);
      });

      it('should reject vbscript: protocol', () => {
        expect(isValidUnsubscribeUrl('vbscript:msgbox(1)')).toBe(false);
      });

      it('should reject about: protocol', () => {
        expect(isValidUnsubscribeUrl('about:blank')).toBe(false);
      });

      it('should reject ftp: protocol', () => {
        expect(isValidUnsubscribeUrl('ftp://example.com/file')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should reject empty or null input', () => {
        expect(isValidUnsubscribeUrl('')).toBe(false);
        expect(isValidUnsubscribeUrl('   ')).toBe(false);
      });

      it('should reject malformed URLs', () => {
        expect(isValidUnsubscribeUrl('not-a-url')).toBe(false);
        expect(isValidUnsubscribeUrl('example.com/unsub')).toBe(false);
        expect(isValidUnsubscribeUrl('//example.com')).toBe(false);
      });

      it('should reject relative URLs', () => {
        expect(isValidUnsubscribeUrl('/unsubscribe')).toBe(false);
        expect(isValidUnsubscribeUrl('../unsub')).toBe(false);
      });
    });
  });

  describe('parseUnsubscribeUrls', () => {
    it('should parse single HTTP URL', () => {
      const result = parseUnsubscribeUrls('<https://example.com/unsub>');
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.mailto).toBeUndefined();
      expect(result.preferred).toBe('http');
    });

    it('should parse single mailto URL', () => {
      const result = parseUnsubscribeUrls('<mailto:unsub@example.com>');
      expect(result.http).toBeUndefined();
      expect(result.mailto).toBe('mailto:unsub@example.com');
      expect(result.preferred).toBe('mailto');
    });

    it('should parse multiple URLs and prefer HTTP', () => {
      const result = parseUnsubscribeUrls('<https://example.com/unsub>, <mailto:unsub@example.com>');
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.mailto).toBe('mailto:unsub@example.com');
      expect(result.preferred).toBe('http');
    });

    it('should prefer HTTP over mailto when both present', () => {
      const result = parseUnsubscribeUrls('<mailto:unsub@example.com>, <https://example.com/unsub>');
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.mailto).toBe('mailto:unsub@example.com');
      expect(result.preferred).toBe('http');
    });

    it('should handle URLs with query parameters', () => {
      const result = parseUnsubscribeUrls('<https://example.com/unsub?token=abc123&id=456>');
      expect(result.http).toBe('https://example.com/unsub?token=abc123&id=456');
      expect(result.preferred).toBe('http');
    });

    it('should handle mailto with query parameters', () => {
      const result = parseUnsubscribeUrls('<mailto:unsub@example.com?subject=Unsubscribe&body=Remove>');
      expect(result.mailto).toBe('mailto:unsub@example.com?subject=Unsubscribe&body=Remove');
      expect(result.preferred).toBe('mailto');
    });

    it('should filter out invalid URLs', () => {
      const result = parseUnsubscribeUrls('<javascript:alert(1)>, <https://example.com/unsub>');
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.preferred).toBe('http');
    });

    it('should return empty object for all invalid URLs', () => {
      const result = parseUnsubscribeUrls('<javascript:alert(1)>, <data:text/html,<script>>');
      expect(result.http).toBeUndefined();
      expect(result.mailto).toBeUndefined();
      expect(result.preferred).toBeUndefined();
    });

    it('should handle empty or null input', () => {
      expect(parseUnsubscribeUrls('')).toEqual({});
      expect(parseUnsubscribeUrls('   ')).toEqual({});
    });

    it('should handle malformed headers without angle brackets', () => {
      const result = parseUnsubscribeUrls('https://example.com/unsub');
      expect(result).toEqual({});
    });

    it('should handle whitespace in headers', () => {
      const result = parseUnsubscribeUrls('  <https://example.com/unsub>  ,  <mailto:unsub@example.com>  ');
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.mailto).toBe('mailto:unsub@example.com');
      expect(result.preferred).toBe('http');
    });

    it('should handle three or more URLs', () => {
      const result = parseUnsubscribeUrls(
        '<https://example.com/unsub>, <http://backup.com/unsub>, <mailto:unsub@example.com>'
      );
      expect(result.http).toBeDefined();
      expect(result.mailto).toBe('mailto:unsub@example.com');
      expect(result.preferred).toBe('http');
    });

    it('should validate email addresses in mailto URLs', () => {
      const result = parseUnsubscribeUrls('<mailto:invalid-email>, <https://example.com/unsub>');
      expect(result.mailto).toBeUndefined();
      expect(result.http).toBe('https://example.com/unsub');
      expect(result.preferred).toBe('http');
    });
  });
});

describe('parseMailtoUrl', () => {
  it('parses address, subject and body', () => {
    const r = parseMailtoUrl('mailto:list@example.com?subject=Unsubscribe%20123&body=Please%20remove');
    expect(r).toEqual({ to: ['list@example.com'], subject: 'Unsubscribe 123', body: 'Please remove' });
  });

  it('keeps a literal plus (RFC 6068 uses percent-encoding only)', () => {
    const r = parseMailtoUrl('mailto:owner+unsub@example.com?subject=a+b');
    expect(r?.to).toEqual(['owner+unsub@example.com']);
    expect(r?.subject).toBe('a+b');
  });

  it('supports multiple recipients and the to param', () => {
    const r = parseMailtoUrl('mailto:a@example.com,b@example.com?to=c@example.com');
    expect(r?.to).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
  });

  it('returns null without a valid recipient', () => {
    expect(parseMailtoUrl('mailto:?subject=x')).toBeNull();
    expect(parseMailtoUrl('mailto:not-an-address')).toBeNull();
    expect(parseMailtoUrl('https://example.com/unsub')).toBeNull();
  });

  it('survives malformed percent-encoding', () => {
    const r = parseMailtoUrl('mailto:list@example.com?subject=%E0%A4%A');
    expect(r?.to).toEqual(['list@example.com']);
    expect(r?.subject).toBe('%E0%A4%A');
  });
});
