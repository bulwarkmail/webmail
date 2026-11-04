// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loginFingerprint } from '../login-fingerprint';

// The registry keeps the server address as typed, the context cookie as the
// login route normalised it. Both must name the same login.
describe('loginFingerprint', () => {
  const base = 'https://mail.example.org';
  const USER = 'alice@example.org';

  it.each([
    'https://Mail.Example.org',
    'https://MAIL.EXAMPLE.ORG/',
    'https://mail.example.org:443',
    'https://mail.example.org:443/',
    'https://mail.example.org//',
  ])('reads %s as the same server', async (raw) => {
    expect(await loginFingerprint(raw, USER)).toBe(await loginFingerprint(base, USER));
  });

  it('drops the default port of http too', async () => {
    expect(await loginFingerprint('http://mail.example.org:80', USER)).toBe(await loginFingerprint('http://mail.example.org', USER));
  });

  it('ignores the case of the username and stray spaces', async () => {
    expect(await loginFingerprint(base, ' Alice@Example.org ')).toBe(await loginFingerprint(base, USER));
  });

  it.each([
    ['another host', 'https://other.example.org', USER],
    ['another port', 'https://mail.example.org:8443', USER],
    ['another scheme', 'http://mail.example.org', USER],
    ['another path', 'https://mail.example.org/jmap', USER],
    ['another user', base, 'bob@example.org'],
  ])('tells %s apart', async (_name, server, user) => {
    expect(await loginFingerprint(server, user)).not.toBe(await loginFingerprint(base, USER));
  });

  it('keeps going on an address that is no URL', async () => {
    expect(await loginFingerprint('not a url/', USER)).toBe(await loginFingerprint('not a url', USER));
  });
});
