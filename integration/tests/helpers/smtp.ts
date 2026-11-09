/**
 * Dependency-free SMTP submission client.
 *
 * Speaks just enough SMTP to authenticate against Stalwart's plaintext
 * submission listener (AUTH LOGIN, no STARTTLS) and inject a message. Used to
 * simulate real inbound mail so the webmail's sync behaviour can be observed.
 * A raw socket keeps the test harness free of a nodemailer dependency.
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ACCOUNTS, ACCOUNT_PASSWORD, GROUP, SMTP_HOST, SMTP_MODE, SMTP_PORT } from './config';
import { JmapClient } from './jmap';

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
  /** Optional single attachment (sent as multipart/mixed, base64). */
  attachment?: { filename: string; contentType: string; content: string };
  /**
   * Optional inline image referenced by the HTML body via `cid:<cid>`. Sent as
   * multipart/related; `base64` is the pre-encoded image payload.
   */
  inlineImage?: { cid: string; contentType: string; base64: string; html: string };
}

class SmtpError extends Error {}

function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

/** The message as it goes over the wire, before dot-stuffing. */
function buildMessage(opts: SendOptions, recipients: string[], extra: Record<string, string> = {}): string {
  const headers: Record<string, string> = {
    From: opts.from,
    To: recipients.join(', '),
    Subject: opts.subject,
    ...extra,
    ...opts.headers,
  };

  let mime: string;
  if (opts.inlineImage) {
    const boundary = 'itrelated_boundary_0001';
    headers['MIME-Version'] = '1.0';
    headers['Content-Type'] = `multipart/related; boundary="${boundary}"`;
    const b64 = opts.inlineImage.base64.replace(/(.{76})/g, '$1\r\n');
    mime = [
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      crlf(opts.inlineImage.html),
      `--${boundary}`,
      `Content-Type: ${opts.inlineImage.contentType}`,
      `Content-ID: <${opts.inlineImage.cid}>`,
      'Content-Disposition: inline',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      `--${boundary}--`,
    ].join('\r\n');
  } else if (opts.attachment) {
    const boundary = 'itmixed_boundary_0001';
    headers['MIME-Version'] = '1.0';
    headers['Content-Type'] = `multipart/mixed; boundary="${boundary}"`;
    const b64 = Buffer.from(opts.attachment.content).toString('base64').replace(/(.{76})/g, '$1\r\n');
    mime = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      crlf(opts.body),
      `--${boundary}`,
      `Content-Type: ${opts.attachment.contentType}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    mime = crlf(opts.body);
  }

  const headerBlock = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return `${headerBlock}\r\n\r\n${mime}`;
}

/** IT_SMTP_MODE=jmap-import: each recipient's Inbox gets the message through Email/import. */
async function importMessage(opts: SendOptions, recipients: string[]): Promise<void> {
  const known = new Set(Object.values(ACCOUNTS).map((a) => a.email));
  const raw = buildMessage(opts, recipients, {
    Date: new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${randomUUID()}@integration-tests>`,
  });
  for (const rcpt of recipients) {
    if (rcpt === GROUP.team.email) {
      // The group has no login: its member files it into the group's Inbox.
      const member = await JmapClient.connect(ACCOUNTS[GROUP.team.memberOf].email, ACCOUNT_PASSWORD);
      await member.importRaw(raw, 'inbox', member.accountIdByName(rcpt));
      continue;
    }
    if (!known.has(rcpt)) throw new SmtpError(`IT_SMTP_MODE=jmap-import can't deliver to ${rcpt}: not a test account`);
    const client = await JmapClient.connect(rcpt, ACCOUNT_PASSWORD);
    await client.importRaw(raw);
  }
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
  if (SMTP_MODE === 'jmap-import') return importMessage(opts, recipients);

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

    // Dot-stuff any line that begins with '.'
    const safeBody = buildMessage(opts, recipients).replace(/\r\n\./g, '\r\n..');
    send(`${safeBody}\r\n.`);
    await waitReply('250');
    send('QUIT');
    await waitReply('221').catch(() => { /* some servers drop before 221 */ });
  } finally {
    socket.destroy();
  }
}
