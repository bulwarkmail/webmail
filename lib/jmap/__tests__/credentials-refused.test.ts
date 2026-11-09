import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../client';

// A 401 after a fresh try at signing in is the one signal a password login has
// that its credentials are over. So what else looks like one must not count.

const SERVER = 'https://mail.example.test';
const problem = () => new Response(JSON.stringify({ type: 'about:blank', status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' }), { status: 401, headers: { 'Content-Type': 'application/problem+json' } });
const html401 = () => new Response('<html>Sign in to the proxy</html>', { status: 401, headers: { 'Content-Type': 'text/html' } });
const session = () => new Response(JSON.stringify({
  apiUrl: `${SERVER}/jmap`, downloadUrl: `${SERVER}/d`, uploadUrl: `${SERVER}/u`, eventSourceUrl: '', username: 'alice',
  capabilities: { 'urn:ietf:params:jmap:core': {} }, accounts: { a: { name: 'alice', isPersonal: true, accountCapabilities: {} } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const echo = () => new Response(JSON.stringify({ methodResponses: [['Core/echo', { ping: 'pong' }, '0']], sessionState: 's' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

let answers: { api: () => Response; session: () => Response };

function stubServer(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => (String(input).includes('/.well-known/jmap') ? answers.session() : answers.api())));
}

async function connectedBasic(): Promise<{ client: JMAPClient; refused: number[] }> {
  answers = { session, api: echo };
  const client = new JMAPClient(SERVER, 'alice', 'secret');
  await client.connect();
  const refused: number[] = [];
  client.onCredentialsRefused((ms) => refused.push(ms));
  return { client, refused };
}

beforeEach(() => {
  vi.useRealTimers();
  stubServer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a password login', () => {
  it('counts when the session URL refuses too', async () => {
    const { client, refused } = await connectedBasic();
    answers = { api: problem, session: problem };
    await client.ping().catch(() => {});
    expect(refused).toHaveLength(1);
    client.disconnect();
  });

  it('counts when the session answers and the retry is refused', async () => {
    const { client, refused } = await connectedBasic();
    answers = { api: problem, session };
    await client.ping().catch(() => {});
    expect(refused).toHaveLength(1);
    client.disconnect();
  });

  it('doesn\'t count when the session URL gives a 500: that says nothing about the password', async () => {
    const { client, refused } = await connectedBasic();
    answers = { api: problem, session: () => new Response('oops', { status: 500 }) };
    await client.ping().catch(() => {});
    expect(refused).toEqual([]);
    client.disconnect();
  });

  it('doesn\'t count when the network breaks on the way', async () => {
    const { client, refused } = await connectedBasic();
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).includes('/.well-known/jmap')) throw new TypeError('Failed to fetch');
      return problem();
    }));
    await client.ping().catch(() => {});
    expect(refused).toEqual([]);
    client.disconnect();
  });

  it('doesn\'t count a proxy\'s page', async () => {
    const { client, refused } = await connectedBasic();
    answers = { api: html401, session: html401 };
    await client.ping().catch(() => {});
    expect(refused).toEqual([]);
    client.disconnect();
  });

  it('doesn\'t count a plain 500, or a 403', async () => {
    const { client, refused } = await connectedBasic();
    answers = { api: () => new Response('nope', { status: 500 }), session };
    await client.ping().catch(() => {});
    answers = { api: () => new Response(JSON.stringify({ status: 403 }), { status: 403 }), session };
    await client.ping().catch(() => {});
    expect(refused).toEqual([]);
    client.disconnect();
  });

  it('counts at connect, so a restore can tell', async () => {
    answers = { api: echo, session: problem };
    const client = new JMAPClient(SERVER, 'alice', 'secret');
    const refused: number[] = [];
    client.onCredentialsRefused((ms) => refused.push(ms));
    await expect(client.connect()).rejects.toThrow('Invalid username or password');
    expect(refused).toHaveLength(1);
  });

  it('never counts with a one-time code: those go stale by themselves', async () => {
    const { client, refused } = await connectedBasic();
    client.enableTotpReauth('secret', async () => null);
    answers = { api: problem, session: problem };
    await client.ping().catch(() => {});
    expect(refused).toEqual([]);
    client.disconnect();
  });

  it('measures from the first refusal, and a good answer starts it over', async () => {
    const { client, refused } = await connectedBasic();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    answers = { api: problem, session: problem };
    await client.ping().catch(() => {});
    now.mockReturnValue(1_090_000);
    await client.ping().catch(() => {});
    expect(refused).toEqual([0, 90_000]);

    answers = { api: echo, session };
    now.mockReturnValue(1_100_000);
    await client.ping();
    answers = { api: problem, session: problem };
    now.mockReturnValue(1_200_000);
    await client.ping().catch(() => {});
    expect(refused).toEqual([0, 90_000, 0]);
    client.disconnect();
  });
});

describe('a token login', () => {
  function bearer(renewed: string | null): { client: JMAPClient; refused: number[]; renew: ReturnType<typeof vi.fn> } {
    const renew = vi.fn(async () => renewed);
    const client = JMAPClient.withBearer(SERVER, 'old', 'alice', renew);
    const refused: number[] = [];
    client.onCredentialsRefused((ms) => refused.push(ms));
    return { client, refused, renew };
  }

  it('counts when a token issued just now is refused', async () => {
    answers = { api: problem, session: problem };
    const { client, refused, renew } = bearer('new');
    await expect(client.connect()).rejects.toThrow();
    expect(renew).toHaveBeenCalled();
    expect(refused).toHaveLength(1);
  });

  it('doesn\'t count when no new token came: the renewal has its own rules', async () => {
    answers = { api: problem, session: problem };
    const { client, refused } = bearer(null);
    await expect(client.connect()).rejects.toThrow();
    expect(refused).toEqual([]);
  });

  it('counts for a pasted token, which nothing can renew', async () => {
    answers = { api: problem, session: problem };
    const client = JMAPClient.withBearer(SERVER, 'pasted', 'alice');
    const refused: number[] = [];
    client.onCredentialsRefused((ms) => refused.push(ms));
    await expect(client.connect()).rejects.toThrow();
    expect(refused).toHaveLength(1);
  });
});
