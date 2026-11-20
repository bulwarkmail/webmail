// @vitest-environment node
import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ManageSieveClient, openManageSieve } from '../managesieve';
import { SourceError } from '../types';

// The ManageSieve client against a scripted server: each command line the
// client writes is answered from a handler, and STARTTLS "upgrades" the same
// fake socket while recording which lines went out before and after it.

const CAPS = [
  '"IMPLEMENTATION" "Dovecot Pigeonhole"',
  '"SIEVE" "fileinto reject envelope vacation"',
  '"SASL" "PLAIN LOGIN"',
  '"STARTTLS"',
  '"VERSION" "1.0"',
  'OK "Dovecot ready."',
].join('\r\n') + '\r\n';
const TLS_CAPS = CAPS.replace('"STARTTLS"\r\n', '');

const lit = (text: string) => `{${Buffer.byteLength(text)}}\r\n${text}`;

type Handler = (line: string, server: FakeServer) => void;

class FakeServer extends Duplex {
  readonly written: { line: string; tls: boolean }[] = [];
  tls = false;
  private pending = '';

  constructor(private readonly handler: Handler) {
    super();
  }

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, cb: (err?: Error | null) => void) {
    this.pending += chunk.toString('utf8');
    let i;
    while ((i = this.pending.indexOf('\r\n')) >= 0) {
      const line = this.pending.slice(0, i);
      this.pending = this.pending.slice(i + 2);
      this.written.push({ line, tls: this.tls });
      this.handler(line, this);
    }
    cb();
  }

  send(...chunks: (string | Buffer)[]) {
    for (const chunk of chunks) this.push(chunk);
  }

  lines() {
    return this.written.map((w) => w.line);
  }
}

/** The usual Dovecot conversation; `answers` overrides by command word. */
function dovecot(answers: Record<string, Handler> = {}): Handler {
  return (line, server) => {
    const word = line.split(' ')[0];
    const custom = answers[word];
    if (custom) return custom(line, server);
    if (word === 'STARTTLS') server.send('OK "Begin TLS negotiation now."\r\n');
    else if (word === 'AUTHENTICATE') server.send('OK "Logged in."\r\n');
    else if (word === 'LOGOUT') server.send('OK "Logout completed."\r\n');
    else server.send('NO "Unknown command."\r\n');
  };
}

function setup(handler: Handler, { greeting = CAPS, timeoutMs = 1000 } = {}) {
  const server = new FakeServer(handler);
  const upgrade = vi.fn(async (socket: Duplex) => {
    const s = socket as FakeServer;
    s.tls = true;
    // The real server speaks again only after the handshake.
    setImmediate(() => s.send(TLS_CAPS));
    return s;
  });
  const client = new ManageSieveClient(server, { upgrade, timeoutMs });
  server.send(greeting);
  return { server, client, upgrade };
}

async function caught(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SourceError);
    return err as SourceError;
  }
  throw new Error('expected a rejection');
}

describe('ManageSieveClient', () => {
  it('reads the greeting capabilities and the ones re-sent after STARTTLS', async () => {
    const { client, upgrade } = setup(dovecot());
    await client.readGreeting();
    expect(client.capabilities.get('SASL')).toBe('PLAIN LOGIN');
    expect(client.capabilities.get('IMPLEMENTATION')).toBe('Dovecot Pigeonhole');
    expect(client.capabilities.has('STARTTLS')).toBe(true);

    await client.startTls();
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(client.capabilities.has('STARTTLS')).toBe(false);
    expect(client.capabilities.get('VERSION')).toBe('1.0');
  });

  it('authenticates with PLAIN, the login verbatim, only after STARTTLS', async () => {
    const { server, client } = setup(dovecot());
    await client.open('user*admin', 'secret');

    expect(server.written.map((w) => w.line.split(' ')[0])).toEqual(['STARTTLS', 'AUTHENTICATE']);
    expect(server.written[0].tls).toBe(false);
    const auth = server.written[1];
    expect(auth.tls).toBe(true);
    const b64 = Buffer.from('\0user*admin\0secret').toString('base64');
    expect(auth.line).toBe(`AUTHENTICATE "PLAIN" "${b64}"`);
  });

  it('fails with tls and sends no credentials when STARTTLS is refused', async () => {
    const { server, client, upgrade } = setup(dovecot({ STARTTLS: (_l, s) => s.send('NO "TLS not configured"\r\n') }));
    const err = await caught(client.open('user*admin', 'secret'));
    expect(err.kind).toBe('tls');
    expect(upgrade).not.toHaveBeenCalled();
    expect(server.lines()).toEqual(['STARTTLS']);
  });

  it('fails with tls and sends nothing when STARTTLS is not advertised', async () => {
    const { server, client } = setup(dovecot(), { greeting: TLS_CAPS });
    const err = await caught(client.open('user', 'secret'));
    expect(err.kind).toBe('tls');
    expect(server.lines()).toEqual([]);
    expect(server.destroyed).toBe(true);
  });

  it('refuses to authenticate without STARTTLS even when called directly', async () => {
    const { server, client } = setup(dovecot());
    await client.readGreeting();
    const err = await caught(client.authenticate('user', 'secret'));
    expect(err.kind).toBe('tls');
    expect(server.lines()).toEqual([]);
  });

  it('refuses plaintext the server sends along with its STARTTLS answer', async () => {
    const { client, upgrade } = setup(dovecot({ STARTTLS: (_l, s) => s.send('OK\r\n"SASL" "PLAIN"\r\nOK\r\n') }));
    const err = await caught(client.open('user', 'secret'));
    expect(err.kind).toBe('protocol');
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('reports a certificate problem in the handshake as tls', async () => {
    const server = new FakeServer(dovecot());
    const upgrade = vi.fn(async () => {
      throw Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
    });
    const client = new ManageSieveClient(server, { upgrade, timeoutMs: 1000 });
    server.send(CAPS);
    const err = await caught(client.open('user', 'secret'));
    expect(err.kind).toBe('tls');
    expect(server.lines()).toEqual(['STARTTLS']);
  });

  it('fails with auth when the login is refused, without the password in the message', async () => {
    const { client } = setup(dovecot({ AUTHENTICATE: (_l, s) => s.send('NO (AUTH) "Authentication failed."\r\n') }));
    const err = await caught(client.open('user*admin', 'secret'));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('secret');
    expect(err.message).toContain('Authentication failed.');
  });

  it('treats TRYLATER on login as a network problem worth retrying', async () => {
    const { client } = setup(dovecot({ AUTHENTICATE: (_l, s) => s.send('NO (TRYLATER) "Try again"\r\n') }));
    expect((await caught(client.open('user', 'secret'))).kind).toBe('network');
  });

  it('lists quoted names, the ACTIVE marker and literal names', async () => {
    const { client } = setup(dovecot({
      LISTSCRIPTS: (_l, s) => s.send(
        `"vacation"\r\n"main \\"filters\\"" ACTIVE\r\n${lit('Spam für\r\nalle')}\r\n${lit('x')} active\r\nOK "Listscripts completed."\r\n`,
      ),
    }));
    await client.open('user', 'secret');
    await expect(client.listScripts()).resolves.toEqual([
      { name: 'vacation', active: false },
      { name: 'main "filters"', active: true },
      { name: 'Spam für\r\nalle', active: false },
      { name: 'x', active: true },
    ]);
  });

  it('returns a script sent as a literal, counted in octets', async () => {
    const script = 'require "fileinto";\r\n# Grüße — Übertrag\r\nif header :contains "subject" "{5}" { fileinto "Spam"; }\r\n';
    const { server, client } = setup(dovecot({
      GETSCRIPT: (_l, s) => s.send(`${lit(script)}\r\nOK "Getscript completed."\r\n`),
    }));
    await client.open('user', 'secret');
    await expect(client.getScript('Grüße "1"')).resolves.toBe(script);
    expect(server.lines().at(-1)).toBe('GETSCRIPT "Grüße \\"1\\""');
  });

  it('reassembles a literal split across chunks, even inside a multibyte character', async () => {
    const script = 'keep; # äöü ß\r\nstop;\r\n';
    const bytes = Buffer.from(`{${Buffer.byteLength(script)}+}\r\n${script}\r\nOK\r\n`);
    const cut = bytes.indexOf(Buffer.from('ä')) + 1;
    const { client } = setup(dovecot({
      GETSCRIPT: (_l, s) => {
        const parts = [bytes.subarray(0, 3), bytes.subarray(3, cut), bytes.subarray(cut, cut + 4), bytes.subarray(cut + 4)];
        const next = () => {
          const part = parts.shift();
          if (!part) return;
          s.send(part);
          setImmediate(next);
        };
        next();
      },
    }));
    await client.open('user', 'secret');
    await expect(client.getScript('main')).resolves.toBe(script);
  });

  it('reports a missing script as protocol and keeps the session usable', async () => {
    const { client } = setup(dovecot({
      GETSCRIPT: (_l, s) => s.send('NO (NONEXISTENT) "There is no script by that name"\r\n'),
      LISTSCRIPTS: (_l, s) => s.send('"a"\r\nOK\r\n'),
    }));
    await client.open('user', 'secret');
    expect((await caught(client.getScript('gone'))).kind).toBe('protocol');
    await expect(client.listScripts()).resolves.toEqual([{ name: 'a', active: false }]);
  });

  it('fails with network when the server closes mid-response', async () => {
    const { client } = setup(dovecot({
      LISTSCRIPTS: (_l, s) => {
        s.send('"a"\r\n');
        s.push(null);
      },
    }));
    await client.open('user', 'secret');
    const err = await caught(client.listScripts());
    expect(err.kind).toBe('network');
    expect((await caught(client.getScript('a'))).kind).toBe('network');
  });

  it('fails with network when the server stops answering', async () => {
    const { server, client } = setup(dovecot({ LISTSCRIPTS: () => {} }), { timeoutMs: 30 });
    await client.open('user', 'secret');
    const err = await caught(client.listScripts());
    expect(err.kind).toBe('network');
    expect(server.destroyed).toBe(true);
  });

  it('fails with protocol on a malformed literal', async () => {
    const { client } = setup(dovecot({ LISTSCRIPTS: (_l, s) => s.send('{abc}\r\nOK\r\n') }));
    await client.open('user', 'secret');
    expect((await caught(client.listScripts())).kind).toBe('protocol');
  });

  it('sends LOGOUT on close and destroys the socket', async () => {
    const { server, client } = setup(dovecot());
    await client.open('user', 'secret');
    await client.close();
    expect(server.lines().at(-1)).toBe('LOGOUT');
    expect(server.destroyed).toBe(true);
    await client.close();
    expect(server.lines().filter((l) => l === 'LOGOUT')).toHaveLength(1);
  });

  it('never writes a modifying command', async () => {
    const { server, client } = setup(dovecot({
      LISTSCRIPTS: (_l, s) => s.send('"a" ACTIVE\r\nOK\r\n'),
      GETSCRIPT: (_l, s) => s.send(`${lit('keep;')}\r\nOK\r\n`),
    }));
    await client.open('user', 'secret');
    await client.listScripts();
    await client.getScript('a');
    await client.close();
    expect(server.lines().map((l) => l.split(' ')[0])).toEqual(['STARTTLS', 'AUTHENTICATE', 'LISTSCRIPTS', 'GETSCRIPT', 'LOGOUT']);
  });
});

describe('openManageSieve', () => {
  it('refuses a blocked address before connecting', async () => {
    const err = await caught(openManageSieve({
      host: '127.0.0.1', port: 4190, login: 'user', password: 'secret', allowPrivateHost: true,
    }));
    expect(err.kind).toBe('blocked');
    expect(err.message).not.toContain('secret');
  });
});
