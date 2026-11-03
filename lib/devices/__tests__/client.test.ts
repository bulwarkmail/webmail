import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInWithInstance, describePlatform, registerWithInstance, reportWipeToInstance } from '../client';

const record = { id: `${'a'.repeat(64)}/${'b'.repeat(32)}`, secret: 'c'.repeat(64) };

function answer(status: number, body: string, type = 'application/json'): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': type } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('a check-in', () => {
  it('hears a wipe only from a clear yes', async () => {
    answer(200, JSON.stringify({ wipe: { requestedAt: '2026-11-03T00:00:00Z' } }));
    expect(await checkInWithInstance(record)).toBe('wipe');
  });

  it('reads no wipe as clear', async () => {
    answer(200, JSON.stringify({ wipe: null }));
    expect(await checkInWithInstance(record)).toBe('clear');
  });

  it('reads the route\'s own 404 as a forgotten row', async () => {
    answer(404, JSON.stringify({ error: 'unknown_device' }));
    expect(await checkInWithInstance(record)).toBe('forgotten');
  });

  it.each([
    ['an older instance\'s 404', 404, '<html>Not found</html>', 'text/html'],
    ['a 500', 500, JSON.stringify({ error: 'Internal server error' }), 'application/json'],
    ['a 503', 503, '<html>Bad gateway</html>', 'text/html'],
    ['a 200 from something else', 200, '<html>Login</html>', 'text/html'],
    ['a 200 with other JSON', 200, JSON.stringify({ ok: true }), 'application/json'],
    ['a 401', 401, JSON.stringify({ wipe: { requestedAt: 'x' } }), 'application/json'],
  ])('reads %s as nothing', async (_name, status, body, type) => {
    answer(status, body, type);
    expect(await checkInWithInstance(record)).toBe('unavailable');
  });

  it('reads no network as nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await checkInWithInstance(record)).toBe('unavailable');
  });
});

describe('registering', () => {
  it('names the account\'s cookie slot', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(record), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await registerWithInstance(3)).toEqual(record);
    const init = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect((init.headers as Record<string, string>)['X-JMAP-Cookie-Slot']).toBe('3');
  });

  it('gives null when it can\'t', async () => {
    answer(401, '{}');
    expect(await registerWithInstance(0)).toBeNull();
  });
});

describe('reporting a wipe', () => {
  const entry = { ...record, reason: 'admin' as const, unsent: 1 };

  it('is done on a yes, and when the row is gone', async () => {
    answer(200, JSON.stringify({ ok: true }));
    expect(await reportWipeToInstance(entry)).toBe(true);
    answer(404, JSON.stringify({ error: 'unknown_device' }));
    expect(await reportWipeToInstance(entry)).toBe(true);
  });

  it('tries again after anything else', async () => {
    answer(500, '{}');
    expect(await reportWipeToInstance(entry)).toBe(false);
    answer(404, '<html>');
    expect(await reportWipeToInstance(entry)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await reportWipeToInstance(entry)).toBe(false);
  });
});

describe('what a row calls the device', () => {
  it('names the desktop app', () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'instance' };
    expect(describePlatform()).toBe('Desktop app, Windows');
  });

  it('names a browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
    expect(describePlatform()).toBe('Chrome, Windows');
  });
});
