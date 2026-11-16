import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../client';

// An app woken from the background (a frozen iOS PWA, a sleeping laptop) still
// holds a token that ran out while its refresh timer was frozen. Every request
// it then sends at once came back 401, and a burst of those got the address
// banned by CrowdSec (#1720). A known expiry is renewed before anything goes out.

const SERVER = 'https://mail.example.test';
const HOUR = 3600;
const session = () => new Response(JSON.stringify({
  apiUrl: `${SERVER}/jmap`, downloadUrl: `${SERVER}/d`, uploadUrl: `${SERVER}/u`, eventSourceUrl: '', username: 'alice',
  capabilities: { 'urn:ietf:params:jmap:core': {} }, accounts: { a: { name: 'alice', isPersonal: true, accountCapabilities: {} } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const echo = () => new Response(JSON.stringify({ methodResponses: [['Core/echo', { ping: 'pong' }, '0']], sessionState: 's' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const refused = () => new Response(JSON.stringify({ type: 'about:blank', status: 401, title: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/problem+json' } });

/** The token the server accepts; anything else is refused. */
let validToken: string;
/** Authorization headers the server refused, in order. */
let refusedHeaders: string[];
/** Runs as a request arrives, before it is answered. */
let onArrival: (() => void) | null;

function stubServer(): void {
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    onArrival?.();
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== `Bearer ${validToken}`) {
      refusedHeaders.push(auth);
      return refused();
    }
    return String(_input).includes('/.well-known/jmap') ? session() : echo();
  }));
}

/** Renews to `next`, one renewal shared by everyone asking at once, as refreshAccessToken does. */
function renewal(next: string | null) {
  let inFlight: Promise<string | null> | null = null;
  const refresh = vi.fn(() => {
    inFlight ??= Promise.resolve().then(() => {
      if (next) validToken = next;
      return next;
    }).finally(() => { inFlight = null; });
    return inFlight;
  });
  return refresh;
}

async function connected(refresh: () => Promise<string | null>, expiresIn?: number): Promise<JMAPClient> {
  const client = JMAPClient.withBearer(SERVER, 'old', 'alice', refresh, expiresIn);
  await client.connect();
  return client;
}

const clients: JMAPClient[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  validToken = 'old';
  refusedHeaders = [];
  onArrival = null;
  stubServer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an access token with a known expiry', () => {
  it('is renewed before a burst of requests goes out, when it ran out in the background', async () => {
    const refresh = renewal('fresh');
    const client = await connected(refresh, HOUR);
    clients.push(client);

    vi.setSystemTime(new Date('2026-11-15T15:00:00Z'));
    validToken = ''; // "old" has run out on the server too
    await Promise.all(Array.from({ length: 6 }, () => client.ping()));

    expect(refusedHeaders).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(6);
    expect(client.getAuthHeader()).toBe('Bearer fresh');
  });

  it('is renewed shortly before it runs out, not only after', async () => {
    const refresh = renewal('fresh');
    const client = await connected(refresh, HOUR);
    clients.push(client);

    vi.setSystemTime(new Date(Date.now() + (HOUR - 5) * 1000));
    await client.ping();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refusedHeaders).toEqual([]);
  });

  it('is left alone while it is still good', async () => {
    const refresh = renewal('fresh');
    const client = await connected(refresh, HOUR);
    clients.push(client);

    vi.setSystemTime(new Date(Date.now() + 30 * 60 * 1000));
    await client.ping();

    expect(refresh).not.toHaveBeenCalled();
    expect(client.getAuthHeader()).toBe('Bearer old');
  });

  it('falls back to the 401 when the renewal gives nothing, and does not ask before every request', async () => {
    const refresh = renewal(null);
    const client = await connected(refresh, HOUR);
    clients.push(client);

    vi.setSystemTime(new Date(Date.now() + 2 * HOUR * 1000));
    await client.ping();
    expect(refresh).toHaveBeenCalledOnce();

    await client.ping();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps its expiry when the same token is handed over again without one', async () => {
    const refresh = renewal('fresh');
    const client = await connected(refresh, HOUR);
    clients.push(client);

    client.updateAccessToken('old');
    vi.setSystemTime(new Date(Date.now() + 2 * HOUR * 1000));
    await client.ping();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refusedHeaders).toEqual([]);
  });
});

describe('an access token with no known expiry', () => {
  it('is renewed on the 401, as before', async () => {
    const refresh = renewal('fresh');
    const client = await connected(refresh);
    clients.push(client);

    validToken = 'fresh';
    await client.ping();

    expect(refusedHeaders).toEqual(['Bearer old']);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('a 401 for a token replaced while the request was on its way', () => {
  it('is retried with the current token, without another renewal', async () => {
    const refresh = renewal('another');
    const client = await connected(refresh);
    clients.push(client);

    // The request leaves with "old"; before the answer comes back, another
    // request's renewal hands the client "fresh".
    onArrival = () => {
      onArrival = null;
      validToken = 'fresh';
      client.updateAccessToken('fresh', HOUR);
    };
    await client.ping();

    expect(refusedHeaders).toEqual(['Bearer old']);
    expect(refresh).not.toHaveBeenCalled();
    expect(client.getAuthHeader()).toBe('Bearer fresh');
  });
});
