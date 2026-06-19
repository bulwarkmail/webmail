import { describe, it, expect } from 'vitest';
import {
  normaliseEmail,
  emailHash,
  emailDomain,
  clampSize,
  isPublicHost,
  buildAvatarUrl,
  AVATAR_SIZE_DEFAULT,
  AVATAR_SIZE_MAX,
  AVATAR_SIZE_MIN,
  LIBRAVATAR_CENTRAL_HOST,
} from '@/lib/libravatar';

describe('libravatar helpers', () => {
  it('normalises email (trim + lowercase)', () => {
    expect(normaliseEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('hashes case-insensitively to 64 hex chars (sha256)', () => {
    const a = emailHash('User@Example.com');
    const b = emailHash('user@example.com');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(emailHash('other@example.com')).not.toBe(a);
  });

  it('extracts the domain for valid addresses, null otherwise', () => {
    expect(emailDomain('jane@sub.example.co.uk')).toBe('sub.example.co.uk');
    expect(emailDomain('not-an-email')).toBeNull();
    expect(emailDomain('a@b')).toBeNull(); // no TLD
  });

  it('clamps avatar size', () => {
    expect(clampSize(null)).toBe(AVATAR_SIZE_DEFAULT);
    expect(clampSize('abc')).toBe(AVATAR_SIZE_DEFAULT);
    expect(clampSize('1')).toBe(AVATAR_SIZE_MIN);
    expect(clampSize('99999')).toBe(AVATAR_SIZE_MAX);
    expect(clampSize('128')).toBe(128);
  });

  it('rejects non-public SRV targets (SSRF guard)', () => {
    expect(isPublicHost('avatars.example.com')).toBe(true);
    expect(isPublicHost('localhost')).toBe(false);
    expect(isPublicHost('mail.internal')).toBe(false);
    expect(isPublicHost('foo.local')).toBe(false);
    expect(isPublicHost('10.0.0.5')).toBe(false);
    expect(isPublicHost('')).toBe(false);
  });

  it('builds federated vs central avatar URLs', () => {
    const hash = 'a'.repeat(64);
    expect(buildAvatarUrl(null, hash, 80)).toBe(
      `https://${LIBRAVATAR_CENTRAL_HOST}/avatar/${hash}?s=80&d=404`,
    );
    expect(buildAvatarUrl({ host: 'av.example.com', port: 443 }, hash, 80)).toBe(
      `https://av.example.com/avatar/${hash}?s=80&d=404`,
    );
    expect(buildAvatarUrl({ host: 'av.example.com', port: 8443 }, hash, 96)).toBe(
      `https://av.example.com:8443/avatar/${hash}?s=96&d=404`,
    );
  });
});
