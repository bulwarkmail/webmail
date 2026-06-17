import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  sessionCookieName,
} from '@/lib/auth/session-cookie';

describe('session-cookie', () => {
  it('exposes the legacy cookie name and 30-day max-age', () => {
    expect(SESSION_COOKIE).toBe('jmap_session');
    expect(SESSION_COOKIE_MAX_AGE).toBe(2592000); // 30 * 24 * 60 * 60
  });

  it('uses the bare legacy name for slot 0 (no suffix)', () => {
    expect(sessionCookieName(0)).toBe('jmap_session');
  });

  it('suffixes the slot number for slots > 0', () => {
    expect(sessionCookieName(1)).toBe('jmap_session_1');
    expect(sessionCookieName(49)).toBe('jmap_session_49');
  });
});
