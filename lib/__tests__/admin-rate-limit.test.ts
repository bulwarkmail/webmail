import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The per-IP key is X-Forwarded-For, which a client writes itself when the
// app is reachable without a reverse proxy: a fresh forged address used to
// mean a fresh bucket of five guesses, without end.

async function load() {
  vi.resetModules();
  return import('@/lib/admin/rate-limit');
}

describe('admin login rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows five attempts per address', async () => {
    const { checkRateLimit } = await load();
    for (let i = 0; i < 5; i++) expect(checkRateLimit('203.0.113.1').allowed).toBe(true);
    expect(checkRateLimit('203.0.113.1').allowed).toBe(false);
    expect(checkRateLimit('203.0.113.2').allowed).toBe(true);
  });

  it('stops rotating forged addresses at the global ceiling', async () => {
    const { checkRateLimit } = await load();
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      if (checkRateLimit(`198.51.100.${i}`).allowed) allowed++;
    }
    expect(allowed).toBe(50);
    expect(checkRateLimit('192.0.2.77').allowed).toBe(false);
  });

  it('opens again after the window', async () => {
    const { checkRateLimit } = await load();
    for (let i = 0; i < 60; i++) checkRateLimit(`198.51.100.${i}`);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(checkRateLimit('192.0.2.77').allowed).toBe(true);
  });
});
