import { describe, it, expect } from 'vitest';
import {
  parseSubAddress,
  generateSubAddress,
  extractDomain,
  suggestTagsForDomain,
  isValidTag,
  getTagValidationError,
  isSupportedSubAddressDelimiter,
  SUPPORTED_SUB_ADDRESS_DELIMITERS,
  DEFAULT_SUB_ADDRESS_DELIMITER,
  MAX_TAG_LENGTH,
} from '../sub-addressing';

describe('parseSubAddress', () => {
  describe('standard addresses', () => {
    it('should parse email with tag', () => {
      const result = parseSubAddress('user+shopping@example.com');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBe('shopping');
      expect(result.domain).toBe('example.com');
      expect(result.localPart).toBe('user+shopping');
      expect(result.fullAddress).toBe('user+shopping@example.com');
    });

    it('should parse email with alphanumeric tag', () => {
      const result = parseSubAddress('john+news2024@domain.co.uk');
      expect(result.baseUser).toBe('john');
      expect(result.tag).toBe('news2024');
      expect(result.domain).toBe('domain.co.uk');
    });

    it('should parse email with dash in tag', () => {
      const result = parseSubAddress('alice+my-orders@shop.com');
      expect(result.tag).toBe('my-orders');
    });
  });

  describe('no tag', () => {
    it('should handle email without plus sign', () => {
      const result = parseSubAddress('user@example.com');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBeNull();
      expect(result.domain).toBe('example.com');
      expect(result.localPart).toBe('user');
    });

    it('should handle dotted local part without tag', () => {
      const result = parseSubAddress('first.last@example.com');
      expect(result.baseUser).toBe('first.last');
      expect(result.tag).toBeNull();
    });
  });

  describe('multiple plus signs', () => {
    it('should use first plus as separator', () => {
      const result = parseSubAddress('user+tag1+tag2@example.com');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBe('tag1+tag2');
      expect(result.localPart).toBe('user+tag1+tag2');
    });
  });

  describe('empty tag', () => {
    it('should return null tag for trailing plus', () => {
      const result = parseSubAddress('user+@example.com');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle missing domain', () => {
      const result = parseSubAddress('user');
      expect(result.localPart).toBe('user');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBeNull();
      expect(result.domain).toBe('');
    });

    it('should handle missing local part', () => {
      const result = parseSubAddress('@example.com');
      expect(result.localPart).toBe('');
      expect(result.baseUser).toBe('');
      expect(result.tag).toBeNull();
      expect(result.domain).toBe('example.com');
    });

    it('should handle empty string', () => {
      const result = parseSubAddress('');
      expect(result.localPart).toBe('');
      expect(result.baseUser).toBe('');
      expect(result.tag).toBeNull();
      expect(result.domain).toBe('');
    });

    it('should preserve full address', () => {
      const email = 'test+dev@mail.example.org';
      const result = parseSubAddress(email);
      expect(result.fullAddress).toBe(email);
    });

    it('should handle plus at start of local part', () => {
      const result = parseSubAddress('+tag@example.com');
      expect(result.baseUser).toBe('');
      expect(result.tag).toBe('tag');
    });
  });
});

describe('generateSubAddress', () => {
  describe('basic generation', () => {
    it('should generate tagged address', () => {
      expect(generateSubAddress('user@example.com', 'shopping')).toBe('user+shopping@example.com');
    });

    it('should lowercase the tag', () => {
      expect(generateSubAddress('user@example.com', 'Shopping')).toBe('user+shopping@example.com');
    });

    it('should allow dashes in tag', () => {
      expect(generateSubAddress('user@example.com', 'my-orders')).toBe('user+my-orders@example.com');
    });
  });

  describe('replace existing tag', () => {
    it('should replace existing tag with new one', () => {
      expect(generateSubAddress('user+old@example.com', 'new')).toBe('user+new@example.com');
    });

    it('should replace complex existing tag', () => {
      expect(generateSubAddress('user+tag1+tag2@example.com', 'fresh')).toBe('user+fresh@example.com');
    });
  });

  describe('empty or invalid tag', () => {
    it('should return original email for empty tag', () => {
      expect(generateSubAddress('user@example.com', '')).toBe('user@example.com');
    });

    it('should return original email for tag with only invalid chars', () => {
      expect(generateSubAddress('user@example.com', '!@#$%')).toBe('user@example.com');
    });
  });

  describe('tag sanitization', () => {
    it('should strip special characters from tag', () => {
      expect(generateSubAddress('user@example.com', 'my_tag!')).toBe('user+mytag@example.com');
    });

    it('should strip spaces from tag', () => {
      expect(generateSubAddress('user@example.com', 'my tag')).toBe('user+mytag@example.com');
    });

    it('should keep alphanumeric and dash', () => {
      expect(generateSubAddress('user@example.com', 'valid-tag-123')).toBe('user+valid-tag-123@example.com');
    });
  });

  describe('missing domain', () => {
    it('should return original for email without domain', () => {
      expect(generateSubAddress('user', 'tag')).toBe('user');
    });

    it('should return original for email without local part', () => {
      expect(generateSubAddress('@example.com', 'tag')).toBe('@example.com');
    });
  });
});

describe('extractDomain', () => {
  it('should extract domain from standard email', () => {
    expect(extractDomain('user@example.com')).toBe('example.com');
  });

  it('should extract domain from sub-addressed email', () => {
    expect(extractDomain('user+tag@mail.example.org')).toBe('mail.example.org');
  });

  it('should normalize domain to lowercase', () => {
    expect(extractDomain('user@EXAMPLE.COM')).toBe('example.com');
  });

  it('should return null for email without @', () => {
    expect(extractDomain('nodomain')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(extractDomain('')).toBeNull();
  });

  it('should handle multiple @ symbols', () => {
    expect(extractDomain('user@host@example.com')).toBe('example.com');
  });
});

describe('suggestTagsForDomain', () => {
  describe('known domains', () => {
    it('should return suggestions for amazon.com', () => {
      const tags = suggestTagsForDomain('amazon.com');
      expect(tags).toContain('amazon');
      expect(tags).toContain('shopping');
      expect(tags).toContain('orders');
    });

    it('should return suggestions for github.com', () => {
      const tags = suggestTagsForDomain('github.com');
      expect(tags).toContain('github');
      expect(tags).toContain('dev');
      expect(tags).toContain('notifications');
    });

    it('should return suggestions for paypal.com', () => {
      const tags = suggestTagsForDomain('paypal.com');
      expect(tags).toContain('paypal');
      expect(tags).toContain('payments');
    });

    it('should return suggestions for netflix.com', () => {
      const tags = suggestTagsForDomain('netflix.com');
      expect(tags).toContain('netflix');
      expect(tags).toContain('entertainment');
    });

    it('should return suggestions for regional Amazon domains', () => {
      expect(suggestTagsForDomain('amazon.fr')).toContain('amazon');
      expect(suggestTagsForDomain('amazon.de')).toContain('shopping');
      expect(suggestTagsForDomain('amazon.co.uk')).toContain('orders');
    });
  });

  describe('unknown domains', () => {
    it('should return generic suggestions with domain name', () => {
      const tags = suggestTagsForDomain('randomsite.com');
      expect(tags).toContain('randomsite');
      expect(tags).toContain('newsletter');
      expect(tags).toContain('registration');
    });

    it('should extract main domain from multi-part TLD', () => {
      const tags = suggestTagsForDomain('unknown.co.uk');
      expect(tags[0]).toBe('co');
    });
  });

  describe('subdomains', () => {
    it('should extract main domain from subdomain', () => {
      const tags = suggestTagsForDomain('mail.google.com');
      expect(tags[0]).toBe('google');
    });

    it('should extract main domain from deep subdomain', () => {
      const tags = suggestTagsForDomain('smtp.mail.provider.com');
      expect(tags[0]).toBe('provider');
    });
  });

  describe('case-insensitive matching', () => {
    it('should match known domains case-insensitively', () => {
      expect(suggestTagsForDomain('GITHUB.COM')).toContain('github');
      expect(suggestTagsForDomain('GitHub.com')).toContain('github');
    });

    it('should match regional domains case-insensitively', () => {
      expect(suggestTagsForDomain('AMAZON.FR')).toContain('amazon');
    });
  });
});

describe('isValidTag', () => {
  describe('valid tags', () => {
    it('should accept lowercase letters', () => {
      expect(isValidTag('shopping')).toBe(true);
    });

    it('should accept uppercase letters', () => {
      expect(isValidTag('Shopping')).toBe(true);
    });

    it('should accept numbers', () => {
      expect(isValidTag('tag123')).toBe(true);
    });

    it('should accept dashes', () => {
      expect(isValidTag('my-tag')).toBe(true);
    });

    it('should accept single character', () => {
      expect(isValidTag('a')).toBe(true);
    });

    it('should accept max length tag', () => {
      expect(isValidTag('a'.repeat(MAX_TAG_LENGTH))).toBe(true);
    });
  });

  describe('invalid tags', () => {
    it('should reject empty string', () => {
      expect(isValidTag('')).toBe(false);
    });

    it('should reject underscores', () => {
      expect(isValidTag('my_tag')).toBe(false);
    });

    it('should reject dots', () => {
      expect(isValidTag('my.tag')).toBe(false);
    });

    it('should reject spaces', () => {
      expect(isValidTag('my tag')).toBe(false);
    });

    it('should reject special characters', () => {
      expect(isValidTag('tag!')).toBe(false);
      expect(isValidTag('tag@')).toBe(false);
      expect(isValidTag('tag#')).toBe(false);
    });

    it('should reject tag exceeding max length', () => {
      expect(isValidTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBe(false);
    });
  });
});

describe('getTagValidationError', () => {
  it('should return null for valid tag', () => {
    expect(getTagValidationError('shopping')).toBeNull();
    expect(getTagValidationError('my-tag-123')).toBeNull();
  });

  it('should return EMPTY for empty string', () => {
    expect(getTagValidationError('')).toBe('EMPTY');
  });

  it('should return TOO_LONG for oversized tag', () => {
    expect(getTagValidationError('a'.repeat(MAX_TAG_LENGTH + 1))).toBe('TOO_LONG');
  });

  it('should return INVALID_CHARS for special characters', () => {
    expect(getTagValidationError('tag!')).toBe('INVALID_CHARS');
    expect(getTagValidationError('tag with spaces')).toBe('INVALID_CHARS');
    expect(getTagValidationError('tag_underscore')).toBe('INVALID_CHARS');
  });

  it('should check length before characters', () => {
    const longInvalid = '!'.repeat(MAX_TAG_LENGTH + 1);
    expect(getTagValidationError(longInvalid)).toBe('TOO_LONG');
  });

  it('should return null for boundary-length valid tag', () => {
    expect(getTagValidationError('a'.repeat(MAX_TAG_LENGTH))).toBeNull();
  });

  it('should return INVALID_CHARS for unicode characters', () => {
    expect(getTagValidationError('café')).toBe('INVALID_CHARS');
    expect(getTagValidationError('日本語')).toBe('INVALID_CHARS');
  });
});

describe('custom delimiter', () => {
  describe('parseSubAddress with non-default delimiter', () => {
    it('should parse with "-" delimiter', () => {
      const result = parseSubAddress('user-shopping@example.com', '-');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBe('shopping');
    });

    it('should parse with "." delimiter', () => {
      const result = parseSubAddress('user.shopping@example.com', '.');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBe('shopping');
    });

    it('should parse with "=" delimiter', () => {
      const result = parseSubAddress('user=shopping@example.com', '=');
      expect(result.baseUser).toBe('user');
      expect(result.tag).toBe('shopping');
    });

    it('should ignore "+" when "-" is configured as the delimiter', () => {
      const result = parseSubAddress('user+shopping@example.com', '-');
      expect(result.baseUser).toBe('user+shopping');
      expect(result.tag).toBeNull();
    });

    it('should split on first occurrence when delimiter appears multiple times', () => {
      const result = parseSubAddress('alice-shop-orders@example.com', '-');
      expect(result.baseUser).toBe('alice');
      expect(result.tag).toBe('shop-orders');
    });
  });

  describe('generateSubAddress with non-default delimiter', () => {
    it('should generate using "-" delimiter', () => {
      expect(generateSubAddress('user@example.com', 'shopping', '-')).toBe('user-shopping@example.com');
    });

    it('should generate using "." delimiter', () => {
      expect(generateSubAddress('user@example.com', 'shopping', '.')).toBe('user.shopping@example.com');
    });

    it('should replace existing tag using the configured delimiter', () => {
      expect(generateSubAddress('user-old@example.com', 'new', '-')).toBe('user-new@example.com');
    });

    it('should not strip a "+" sign in the local part when delimiter is "-"', () => {
      // "+" is not the delimiter so it should remain part of the base user
      expect(generateSubAddress('user+plus@example.com', 'tag', '-')).toBe('user+plus-tag@example.com');
    });
  });

  describe('isSupportedSubAddressDelimiter', () => {
    it('accepts every supported delimiter', () => {
      for (const delim of SUPPORTED_SUB_ADDRESS_DELIMITERS) {
        expect(isSupportedSubAddressDelimiter(delim)).toBe(true);
      }
    });

    it('rejects unsupported characters', () => {
      expect(isSupportedSubAddressDelimiter('_')).toBe(false);
      expect(isSupportedSubAddressDelimiter('++')).toBe(false);
      expect(isSupportedSubAddressDelimiter('')).toBe(false);
    });

    it('default delimiter is supported', () => {
      expect(isSupportedSubAddressDelimiter(DEFAULT_SUB_ADDRESS_DELIMITER)).toBe(true);
    });
  });
});
