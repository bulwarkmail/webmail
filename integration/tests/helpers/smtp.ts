/**
 * Dependency-free SMTP submission client.
 *
 * Speaks just enough SMTP to authenticate against Stalwart's plaintext
 * submission listener (AUTH LOGIN, no STARTTLS) and inject a message. Used to
 * simulate real inbound mail so the webmail's sync behaviour can be observed.
 * A raw socket keeps the test harness free of a nodemailer dependency.
 */
import net from 'node:net';
import { SMTP_HOST, SMTP_PORT } from './config';

interface SendOptions {
  host?: string;
  port?: number;
  /** Envelope + auth sender, e.g. "alice@example.org". */
  from: string;
  /** Auth username; defaults to `from`. */
  authUser?: string;
  authPass: string;
  /** One or more envelope recipients. */
  to: string | string[];
  subject: string;
  /** Plain-text body. */
  body: string;
  /** Extra headers (e.g. custom Message-ID / In-Reply-To for threading). */
  headers?: Record<string, string>;
}

class SmtpError extends Error {}

function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

/**
 * Submit a single message. Resolves once the server has accepted it (250 after
 * end-of-DATA). Rejects on any non-2xx/3xx reply or socket error.
 */
export async function sendMail(opts: SendOptions): Promise<void> {
  const host = opts.host ?? SMTP_HOST;
  const port = opts.port ?? SMTP_PORT;
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const authUser = opts.authUser ?? opts.from;

  const socket = net.createConnection({ host, port });
  socket.setEncoding('utf8');
  socket.setTimeout(15000);

  let buffer = '';
  let resolveLine: ((line: string) => void) | null = null;
  let pendingError: Error | null = null;

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    // A complete reply ends with "<code> ...\r\n" (space, not hyphen, after code).
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (/^\d{3} /.test(line) && resolveLine) {
        const r = resolveLine;
        resolveLine = null;
        buffer = lines.slice(i + 1).join('\r\n');
        r(line);
        return;
      }
    }
  });
  socket.on('timeout', () => { pendingError = new SmtpError('SMTP timeout'); socket.destroy(); });
  socket.on('error', (e) => { pendingError = e; });

  const waitReply = (expect: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (pendingError) return reject(pendingError);
      resolveLine = (line) => {
        if (!line.startsWith(expect)) {
          reject(new SmtpError(`Expected ${expect}, got: ${line}`));
        } else {
          resolve(line);
        }
      };
    });

  const send = (line: string): void => { socket.write(line + '\r\n'); };
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await waitReply('220');
    send('EHLO integration-tests');
    await waitReply('250');
    send('AUTH LOGIN');
    await waitReply('334');
    send(b64(authUser));
    await waitReply('334');
    send(b64(opts.authPass));
    await waitReply('235');
    send(`MAIL FROM:<${opts.from}>`);
    await waitReply('250');
    for (const rcpt of recipients) {
      send(`RCPT TO:<${rcpt}>`);
      await waitReply('250');
    }
    send('DATA');
    await waitReply('354');

    const headers: Record<string, string> = {
      From: opts.from,
      To: recipients.join(', '),
      Subject: opts.subject,
      'Content-Type': 'text/plain; charset=utf-8',
      ...opts.headers,
    };
    const headerBlock = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    // Dot-stuff any line that begins with '.'
    const safeBody = crlf(opts.body).replace(/\r\n\./g, '\r\n..');
    send(`${headerBlock}\r\n\r\n${safeBody}\r\n.`);
    await waitReply('250');
    send('QUIT');
    await waitReply('221').catch(() => { /* some servers drop before 221 */ });
  } finally {
    socket.destroy();
  }
}
