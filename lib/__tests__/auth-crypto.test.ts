import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encryptSession,
  decryptSession,
  encryptPayload,
  decryptPayload,
} from '@/lib/auth/crypto';

// crypto.ts derives its key solely from getSessionSecret(); mock that one seam
// so we control the secret without touching configManager / env-file lookups.
const { secretRef } = vi.hoisted(() => ({ secretRef: { value: 'x'.repeat(32) } }));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => secretRef.value,
  hasSessionSecret: () => secretRef.value.length > 0,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const SECRET = 'x'.repeat(32);

beforeEach(() => {
  secretRef.value = SECRET;
});

describe('encryptSession / decryptSession', () => {
  it('round-trips a session', () => {
    const token = encryptSession('https://mail.example.com', 'alice', 's3cret');
    expect(decryptSession(token)).toEqual({
      serverUrl: 'https://mail.example.com',
      username: 'alice',
      password: 's3cret',
    });
  });

  it('produces a base64 token with a random IV (two encrypts differ, both decrypt equal)', () => {
    const a = encryptSession('https://x', 'u', 'p');
    const b = encryptSession('https://x', 'u', 'p');
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').toString('base64')).toBe(a); // valid base64
    expect(decryptSession(a)).toEqual(decryptSession(b));
  });

  it('returns null (not throw) on a tampered auth tag', () => {
    const token = encryptSession('https://x', 'u', 'p');
    const buf = Buffer.from(token, 'base64');
    buf[13] ^= 0xff; // flip a byte inside the GCM tag region (bytes 12..28)
    expect(decryptSession(buf.toString('base64'))).toBeNull();
  });

  it('returns null on a token shorter than IV+TAG', () => {
    expect(decryptSession(Buffer.alloc(10).toString('base64'))).toBeNull();
  });

  it('returns null when the version is not 1', () => {
    const token = encryptPayload({ v: 2, serverUrl: 'https://x', username: 'u', password: 'p' });
    expect(decryptSession(token)).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const token = encryptPayload({ v: 1, serverUrl: 'https://x', username: 'u' });
    expect(decryptSession(token)).toBeNull();
  });

  it('throws when no secret is configured', () => {
    secretRef.value = '';
    expect(() => encryptSession('https://x', 'u', 'p')).toThrow('SESSION_SECRET not configured');
  });

  it('throws when the secret is shorter than 32 characters', () => {
    secretRef.value = 'tooshort';
    expect(() => encryptSession('https://x', 'u', 'p')).toThrow(/at least 32 characters/);
  });
});

describe('encryptPayload / decryptPayload', () => {
  it('round-trips an arbitrary object', () => {
    const token = encryptPayload({ a: 1, b: 'two', c: { nested: true } });
    expect(decryptPayload(token)).toEqual({ a: 1, b: 'two', c: { nested: true } });
  });

  it('does NOT enforce the version/field guard that decryptSession applies', () => {
    // CHARACTERISATION: decryptPayload returns whatever JSON parsed, with no
    // v===1 / required-field validation (unlike decryptSession).
    const token = encryptPayload({ v: 2, anything: 'goes' });
    expect(decryptPayload(token)).toEqual({ v: 2, anything: 'goes' });
  });

  it('returns null on a tampered token', () => {
    const token = encryptPayload({ a: 1 });
    const buf = Buffer.from(token, 'base64');
    buf[20] ^= 0xff;
    expect(decryptPayload(buf.toString('base64'))).toBeNull();
  });
});
