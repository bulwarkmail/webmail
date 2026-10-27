// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import { stalwartPasswordLogin } from '@/lib/auth/stalwart-password-login';

// The password login posts the password, the authorization code, the PKCE
// verifier and the client secret to an admin-configured server. A redirect
// from that server (or whatever sits in front of it) must not carry them to
// another origin.

interface Received { path: string; body: string }

const servers: http.Server[] = [];

async function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
}

function stalwart(req: http.IncomingMessage, _body: string, res: http.ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url?.endsWith('/api/auth')
    ? { type: 'authenticated', client_code: 'code-1' }
    : { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
}

function login(serverUrl: string) {
  return stalwartPasswordLogin({
    serverUrl,
    username: 'alice@example.org',
    password: 'hunter2',
    clientId: 'webmail',
    clientSecret: 'admin-secret',
    redirectUri: 'https://webmail.example/en/auth/callback',
    trusted: true,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('stalwartPasswordLogin redirects', () => {
  it('does not re-post the password to another origin', async () => {
    const other = await serve(stalwart);
    const mail = await serve((req, _body, res) => {
      res.statusCode = 307;
      res.setHeader('Location', `${other.origin}${req.url}`);
      res.end();
    });

    const result = await login(mail.origin);

    expect(result.ok).toBe(false);
    expect(other.received).toEqual([]);
  });

  it('does not send the code and client secret to another origin', async () => {
    const other = await serve(stalwart);
    const mail = await serve((req, body, res) => {
      if (req.url?.endsWith('/auth/token')) {
        res.statusCode = 308;
        res.setHeader('Location', `${other.origin}/auth/token`);
        res.end();
        return;
      }
      stalwart(req, body, res);
    });

    const result = await login(mail.origin);

    expect(result).toMatchObject({ ok: false, error: 'token_exchange_failed' });
    expect(other.received).toEqual([]);
  });

  it('follows a redirect that stays on the same origin', async () => {
    const mail = await serve((req, body, res) => {
      if (!req.url?.startsWith('/stalwart/')) {
        res.statusCode = 308;
        res.setHeader('Location', `/stalwart${req.url}`);
        res.end();
        return;
      }
      stalwart(req, body, res);
    });

    const result = await login(mail.origin);

    expect(result).toMatchObject({ ok: true, tokens: { access_token: 'at' } });
    expect(mail.received.map((r) => r.path)).toEqual([
      '/api/auth', '/stalwart/api/auth', '/auth/token', '/stalwart/auth/token',
    ]);
    expect(mail.received[1].body).toContain('hunter2');
  });
});

describe('isAllowedLoginRedirect', () => {
  it('allows the same origin and an http to https upgrade of the same host only', async () => {
    const { isAllowedLoginRedirect } = await import('@/lib/auth/stalwart-password-login');
    expect(isAllowedLoginRedirect('https://mail.example/api/auth', 'https://mail.example/s/api/auth')).toBe(true);
    expect(isAllowedLoginRedirect('http://mail.example/api/auth', 'https://mail.example/api/auth')).toBe(true);
    expect(isAllowedLoginRedirect('http://mail.example:8080/api/auth', 'https://mail.example/api/auth')).toBe(true);
    expect(isAllowedLoginRedirect('https://mail.example/api/auth', 'http://mail.example/api/auth')).toBe(false);
    expect(isAllowedLoginRedirect('https://mail.example/api/auth', 'https://other.example/api/auth')).toBe(false);
    expect(isAllowedLoginRedirect('https://mail.example/api/auth', 'https://mail.example:8443/api/auth')).toBe(false);
    expect(isAllowedLoginRedirect('http://mail.example/api/auth', 'http://mail.example.evil/api/auth')).toBe(false);
  });
});
