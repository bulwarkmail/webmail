/**
 * A read-only ManageSieve client (RFC 5804) for the mailbox migration:
 * capabilities, STARTTLS, AUTHENTICATE "PLAIN", LISTSCRIPTS, GETSCRIPT and
 * LOGOUT. It never sends PUTSCRIPT, SETACTIVE or DELETESCRIPT.
 *
 * The protocol runs over any Duplex with an injectable STARTTLS upgrade, so
 * tests drive it with a scripted fake socket; {@link openManageSieve} wires it
 * to a checked TCP connection and node:tls.
 */
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { resolveCheckedAddress } from '@/lib/security/url-guard';
import { SourceError, type SieveScriptRef, type SieveSource } from './types';

export const DEFAULT_TIMEOUT_MS = 60_000;
const LOGOUT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 64 * 1024;
/** Sieve scripts are small; a huge literal means a broken or hostile server. */
const MAX_LITERAL_BYTES = 16 * 1024 * 1024;

const TLS_CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH',
]);

export interface ManageSieveOptions {
  /** Turns the plain socket into a TLS one after the server agreed to STARTTLS. */
  upgrade: (socket: Duplex) => Promise<Duplex>;
  /** Per command, so a server that stops answering can't hang the job. */
  timeoutMs?: number;
}

type Token = { kind: 'atom' | 'string' | 'code'; value: string };

interface Final {
  status: 'OK' | 'NO' | 'BYE';
  code?: string;
  message: string;
}

interface Response {
  data: Token[][];
  final: Final;
}

/**
 * Maps any error to a SourceError: blocked addresses and certificate
 * problems get their own kinds, everything else `fallback`. Only the error
 * code goes into the message, never anything the caller handed in.
 */
export function toSourceError(err: unknown, fallback: SourceError['kind'], message: string): SourceError {
  if (err instanceof SourceError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  if (code === 'EBLOCKED') return new SourceError(`${message}: the address is not allowed`, 'blocked', { cause: err });
  if (typeof code === 'string' && (TLS_CERT_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))) {
    return new SourceError(`${message}${suffix}`, 'tls', { cause: err });
  }
  return new SourceError(`${message}${suffix}`, fallback, { cause: err });
}

/** Server text for error messages: one line, printable, short. */
function serverText(final: Final): string {
  const text = final.message.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 200);
  const code = final.code ? `${final.code} ` : '';
  return code || text ? `: ${code}${text}`.trimEnd() : '';
}

function quote(value: string): string {
  // Quoted strings can't carry CR, LF or NUL, and script names may not contain them.
  if (/[\r\n\0]/.test(value)) throw new SourceError('A ManageSieve argument contains a line break', 'protocol');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** Tokens of one response line and the size of a literal that ends it, if any. */
function tokenize(line: string): { tokens: Token[]; literal?: number } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      i++;
    } else if (c === '"') {
      let value = '';
      i++;
      for (;;) {
        if (i >= line.length) throw new SourceError('The ManageSieve server sent an unterminated string', 'protocol');
        const ch = line[i++];
        if (ch === '"') break;
        value += ch === '\\' && i < line.length ? line[i++] : ch;
      }
      tokens.push({ kind: 'string', value });
    } else if (c === '(') {
      let depth = 0;
      let inQuote = false;
      const start = i;
      for (; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '\\') i++;
          else if (ch === '"') inQuote = false;
        } else if (ch === '"') inQuote = true;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
      }
      if (depth !== 0) throw new SourceError('The ManageSieve server sent an unbalanced response code', 'protocol');
      tokens.push({ kind: 'code', value: line.slice(start + 1, i) });
      i++;
    } else if (c === '{') {
      const m = /^\{(\d+)\+?\}$/.exec(line.slice(i));
      if (!m) throw new SourceError('The ManageSieve server sent a malformed literal', 'protocol');
      return { tokens, literal: Number(m[1]) };
    } else {
      const end = line.indexOf(' ', i);
      const stop = end < 0 ? line.length : end;
      tokens.push({ kind: 'atom', value: line.slice(i, stop) });
      i = stop;
    }
  }
  return { tokens };
}

function finalOf(tokens: Token[]): Final | null {
  const first = tokens[0];
  if (first?.kind !== 'atom') return null;
  const status = first.value.toUpperCase();
  if (status !== 'OK' && status !== 'NO' && status !== 'BYE') return null;
  let rest = tokens.slice(1);
  let code: string | undefined;
  if (rest[0]?.kind === 'code') {
    code = rest[0].value;
    rest = rest.slice(1);
  }
  const message = rest[0]?.kind === 'string' ? rest[0].value : '';
  return { status, code, message };
}

/** The ManageSieve protocol over a stream the caller connected. */
export class ManageSieveClient implements SieveSource {
  private socket: Duplex;
  private readonly upgrade: ManageSieveOptions['upgrade'];
  private readonly timeoutMs: number;
  private buf: Buffer = Buffer.alloc(0);
  private waiter: { resolve: () => void; reject: (err: SourceError) => void } | null = null;
  private failure: SourceError | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private secured = false;
  private caps = new Map<string, string>();

  constructor(socket: Duplex, options: ManageSieveOptions) {
    this.socket = socket;
    this.upgrade = options.upgrade;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attach(socket);
  }

  /** The last capabilities the server sent, names upper-cased. */
  get capabilities(): ReadonlyMap<string, string> {
    return this.caps;
  }

  /** Greeting, STARTTLS (mandatory), then AUTHENTICATE "PLAIN" with `login` verbatim. */
  async open(login: string, password: string): Promise<void> {
    await this.readGreeting();
    await this.startTls();
    await this.authenticate(login, password);
  }

  async readGreeting(): Promise<void> {
    await this.exclusive(async () => {
      const res = await this.timed(this.readUntilFinal());
      this.expectGreeting(res);
    });
  }

  async startTls(): Promise<void> {
    if (!this.caps.has('STARTTLS')) {
      this.destroy();
      throw new SourceError('The ManageSieve server does not offer STARTTLS', 'tls');
    }
    await this.exclusive(async () => {
      const res = await this.timed(this.command('STARTTLS'));
      if (res.final.status !== 'OK') {
        this.destroy();
        throw new SourceError(`The ManageSieve server refused STARTTLS${serverText(res.final)}`, 'tls');
      }
      // Anything already buffered came in plaintext and could be injected.
      if (this.buf.length > 0) {
        this.destroy();
        throw new SourceError('The ManageSieve server sent data before the TLS handshake', 'protocol');
      }
      const plain = this.socket;
      this.detach(plain);
      plain.on('error', () => {});
      let secure: Duplex;
      try {
        secure = await this.timed(this.upgrade(plain));
      } catch (err) {
        const e = toSourceError(err, 'tls', 'The TLS handshake with the ManageSieve server failed');
        this.fail(e);
        plain.destroy();
        throw e;
      }
      this.socket = secure;
      this.secured = true;
      this.attach(secure);
      // RFC 5804 §2.2: the server re-sends its capabilities after TLS.
      this.caps = new Map();
      const greeting = await this.timed(this.readUntilFinal());
      this.expectGreeting(greeting);
    });
  }

  async authenticate(login: string, password: string): Promise<void> {
    // Credentials only travel over TLS.
    if (!this.secured) throw new SourceError('Refusing to authenticate before STARTTLS', 'tls');
    const sasl = (this.caps.get('SASL') ?? '').toUpperCase().split(/\s+/);
    if (!sasl.includes('PLAIN')) throw new SourceError('The ManageSieve server does not offer SASL PLAIN', 'auth');
    const initial = Buffer.from(`\0${login}\0${password}`, 'utf8').toString('base64');
    await this.exclusive(async () => {
      const final = await this.timed((async () => {
        await this.write(`AUTHENTICATE "PLAIN" "${initial}"\r\n`);
        const first = await this.readLogical();
        const done = finalOf(first);
        if (done) return done;
        // A challenge after a complete PLAIN response: cancel and give up.
        await this.write('"*"\r\n');
        await this.readUntilFinal();
        throw new SourceError('The ManageSieve server sent an unexpected SASL challenge', 'protocol');
      })());
      if (final.status === 'OK') return;
      if (final.status === 'BYE' || /^TRYLATER\b/i.test(final.code ?? '')) {
        throw new SourceError(`The ManageSieve server is unavailable${serverText(final)}`, 'network');
      }
      throw new SourceError(`The ManageSieve server refused the login${serverText(final)}`, 'auth');
    });
  }

  async listScripts(): Promise<SieveScriptRef[]> {
    return this.exclusive(async () => {
      const res = await this.timed(this.command('LISTSCRIPTS'));
      this.expectOk(res.final, 'LISTSCRIPTS');
      return res.data.map((tokens) => {
        if (tokens[0]?.kind !== 'string') throw new SourceError('The ManageSieve server sent a malformed script list', 'protocol');
        const active = tokens[1]?.kind === 'atom' && tokens[1].value.toUpperCase() === 'ACTIVE';
        return { name: tokens[0].value, active };
      });
    });
  }

  async getScript(name: string): Promise<string> {
    const line = `GETSCRIPT ${quote(name)}`;
    return this.exclusive(async () => {
      const res = await this.timed(this.command(line));
      this.expectOk(res.final, 'GETSCRIPT');
      const content = res.data[0]?.[0];
      if (content?.kind !== 'string') throw new SourceError('The ManageSieve server sent no script', 'protocol');
      return content.value;
    });
  }

  /** LOGOUT best-effort, then drop the connection. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.failure) {
      try {
        await this.exclusive(() => this.timed(this.command('LOGOUT'), Math.min(this.timeoutMs, LOGOUT_TIMEOUT_MS)));
      } catch {
        // The connection goes away either way.
      }
    }
    this.destroy();
  }

  /** Drop the connection without a word to the server. */
  destroy(): void {
    this.fail(new SourceError('The ManageSieve connection is closed', 'network'));
  }

  private readonly onData = (chunk: Buffer | string) => {
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    this.wake();
  };

  private readonly onError = (err: Error) => {
    this.fail(toSourceError(err, 'network', 'The connection to the ManageSieve server failed'));
  };

  private readonly onClose = () => {
    this.fail(new SourceError('The ManageSieve server closed the connection', 'network'));
  };

  private attach(socket: Duplex): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onClose);
    socket.on('close', this.onClose);
  }

  private detach(socket: Duplex): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('end', this.onClose);
    socket.off('close', this.onClose);
  }

  private fail(err: SourceError): void {
    if (!this.failure) this.failure = err;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(this.failure);
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async timed<T>(work: Promise<T>, ms = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new SourceError('The ManageSieve server did not answer in time', 'network');
        this.fail(err);
        reject(err);
      }, ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async write(data: string): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(toSourceError(err, 'network', 'Could not write to the ManageSieve server')) : resolve()));
    });
  }

  private async command(line: string): Promise<Response> {
    await this.write(`${line}\r\n`);
    return this.readUntilFinal();
  }

  private fill(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const lf = this.buf.indexOf(0x0a);
      if (lf >= 0) {
        const end = lf > 0 && this.buf[lf - 1] === 0x0d ? lf - 1 : lf;
        const line = this.buf.subarray(0, end).toString('utf8');
        this.buf = this.buf.subarray(lf + 1);
        return line;
      }
      if (this.buf.length > MAX_LINE_BYTES) {
        const err = new SourceError('The ManageSieve server sent an overlong line', 'protocol');
        this.fail(err);
        throw err;
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** One response line, with literals read (by octet count) and inlined as strings. */
  private async readLogical(): Promise<Token[]> {
    const tokens: Token[] = [];
    for (;;) {
      const { tokens: more, literal } = tokenize(await this.readLine());
      tokens.push(...more);
      if (literal === undefined) return tokens;
      if (literal > MAX_LITERAL_BYTES) {
        const err = new SourceError('The ManageSieve server sent an oversized literal', 'protocol');
        this.fail(err);
        throw err;
      }
      tokens.push({ kind: 'string', value: (await this.readBytes(literal)).toString('utf8') });
    }
  }

  private async readUntilFinal(): Promise<Response> {
    const data: Token[][] = [];
    for (;;) {
      const tokens = await this.readLogical();
      const final = finalOf(tokens);
      if (final) return { data, final };
      if (tokens.length > 0) data.push(tokens);
    }
  }

  private expectGreeting(res: Response): void {
    if (res.final.status !== 'OK') {
      this.destroy();
      throw new SourceError(`The ManageSieve server is unavailable${serverText(res.final)}`, 'network');
    }
    const caps = new Map<string, string>();
    for (const tokens of res.data) {
      if (tokens[0]?.kind !== 'string') {
        this.destroy();
        throw new SourceError('The ManageSieve server sent malformed capabilities', 'protocol');
      }
      caps.set(tokens[0].value.toUpperCase(), tokens[1]?.kind === 'string' ? tokens[1].value : '');
    }
    this.caps = caps;
  }

  private expectOk(final: Final, command: string): void {
    if (final.status === 'OK') return;
    if (final.status === 'BYE') {
      this.destroy();
      throw new SourceError(`The ManageSieve server ended the session${serverText(final)}`, 'network');
    }
    throw new SourceError(`The ManageSieve server refused ${command}${serverText(final)}`, 'protocol');
  }
}

/** STARTTLS with node:tls, checking the certificate against `host`. */
function upgradeToTls(socket: Duplex, host: string): Promise<Duplex> {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: isIP(bare) ? undefined : bare });
    const onError = (err: Error) => {
      secure.destroy();
      reject(toSourceError(err, 'tls', 'The TLS handshake with the ManageSieve server failed'));
    };
    secure.once('error', onError);
    secure.once('secureConnect', () => {
      secure.off('error', onError);
      resolve(secure);
    });
  });
}

function connectTcp(address: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SourceError('The ManageSieve server did not answer in time', 'network'));
    }, timeoutMs);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(toSourceError(err, 'network', 'Could not connect to the ManageSieve server'));
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

/**
 * Connects to a ManageSieve server and logs in: the name is resolved and
 * checked once and the socket goes to that address, while TLS verifies the
 * certificate against the name.
 */
export async function openManageSieve(opts: {
  host: string;
  port: number;
  login: string;
  password: string;
  allowPrivateHost: boolean;
  timeoutMs?: number;
}): Promise<SieveSource> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let address: string;
  try {
    ({ address } = await resolveCheckedAddress(opts.host, { allowPrivateHost: opts.allowPrivateHost }));
  } catch (err) {
    throw toSourceError(err, 'network', 'Could not resolve the ManageSieve server');
  }
  const socket = await connectTcp(address, opts.port, timeoutMs);
  const client = new ManageSieveClient(socket, { timeoutMs, upgrade: (plain) => upgradeToTls(plain, opts.host) });
  try {
    await client.open(opts.login, opts.password);
  } catch (err) {
    client.destroy();
    throw err;
  }
  return client;
}
