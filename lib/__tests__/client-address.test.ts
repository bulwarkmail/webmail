import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/session', () => ({ getClientIP: () => '127.0.0.1' }));

import { forwardedClientHeaders } from '@/lib/auth/client-address';

describe('forwardedClientHeaders', () => {
  it('forwards a client address', () => {
    expect(forwardedClientHeaders('203.0.113.7')).toEqual({ 'X-Forwarded-For': '203.0.113.7' });
    expect(forwardedClientHeaders('10.0.0.5')).toEqual({ 'X-Forwarded-For': '10.0.0.5' });
    expect(forwardedClientHeaders('2001:db8::1')).toEqual({ 'X-Forwarded-For': '2001:db8::1' });
  });

  it('forwards nothing for a missing or malformed address', () => {
    expect(forwardedClientHeaders(undefined)).toEqual({});
    expect(forwardedClientHeaders('')).toEqual({});
    expect(forwardedClientHeaders('0.0.0.0')).toEqual({});
    expect(forwardedClientHeaders('::')).toEqual({});
    expect(forwardedClientHeaders('not-an-ip')).toEqual({});
  });

  // Stalwart 1.0 with `clientIpSource: xForwardedFor` (what stalwart-migrate
  // sets for a 0.16 server that used X-Forwarded-For) answers 400 Bad Request
  // to any request whose forwarded client is a loopback address. 0.16 took it.
  it('forwards nothing for a loopback address', () => {
    expect(forwardedClientHeaders('127.0.0.1')).toEqual({});
    expect(forwardedClientHeaders('127.8.9.10')).toEqual({});
    expect(forwardedClientHeaders('::1')).toEqual({});
    expect(forwardedClientHeaders('::ffff:127.0.0.1')).toEqual({});
  });
});
