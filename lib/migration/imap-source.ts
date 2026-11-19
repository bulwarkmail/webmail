import { ImapFlow, type ListResponse } from 'imapflow';
import { resolveCheckedAddress } from '@/lib/security/url-guard';
import { toSourceError } from './managesieve';
import { SourceError, type FolderStatus, type ImapSecurity, type MailSource, type MessageMeta, type SourceFolder } from './types';

/**
 * The IMAP side of a migration, on imapflow. imapflow never resolves the
 * name itself: the host is resolved and checked here (url-guard rules, the
 * admin's intranet host allowed only for an admin-entered source), the
 * connection goes to that address, and TLS gets the name as servername so
 * SNI and the certificate check use it. Folders are opened read-only and
 * messages fetched with BODY.PEEK[], so nothing changes on the source.
 */

export interface ImapLogin {
  host: string;
  port: number;
  security: ImapSecurity;
  user: string;
  password: string;
  allowPrivateHost: boolean;
}

const TIMEOUT_MS = 60_000;

const IP_LITERAL = /^[\d.]+$|:/;

function classify(error: unknown, message: string): SourceError {
  if (error instanceof SourceError) return error;
  const e = error as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string } | null;
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new SourceError('The source refused the login', 'auth', { cause: error });
  }
  return toSourceError(error, 'network', message);
}

function folderOf(entry: ListResponse): SourceFolder {
  const flags = [...entry.flags].map((f) => f.toLowerCase());
  return {
    path: entry.path,
    delimiter: entry.delimiter || '/',
    // imapflow also guesses roles from names; the migration has its own list (folder-roles.ts).
    specialUse: entry.specialUseSource === 'extension' ? entry.specialUse : undefined,
    noselect: flags.includes('\\noselect') || flags.includes('\\nonexistent'),
  };
}

export class ImapMailSource implements MailSource {
  private constructor(private readonly client: ImapFlow) {}

  static async open(login: ImapLogin): Promise<ImapMailSource> {
    if (login.security === 'none' && !login.allowPrivateHost) {
      throw new SourceError('Unencrypted IMAP is only allowed for an intranet server the admin set up', 'blocked');
    }
    let address: string;
    try {
      ({ address } = await resolveCheckedAddress(login.host, { allowPrivateHost: login.allowPrivateHost }));
    } catch (error) {
      throw toSourceError(error, 'network', 'Could not resolve the IMAP server');
    }
    const client = new ImapFlow({
      host: address,
      port: login.port,
      secure: login.security === 'tls',
      doSTARTTLS: login.security === 'starttls' ? true : login.security === 'none' ? false : undefined,
      ...(IP_LITERAL.test(login.host) ? {} : { servername: login.host }),
      auth: { user: login.user, pass: login.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS * 5,
    });
    // An error after connect must not crash the process; the next command reports it.
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw classify(error, 'Could not sign in to the IMAP server');
    }
    return new ImapMailSource(client);
  }

  private async run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw classify(error, what);
    }
  }

  listFolders(): Promise<SourceFolder[]> {
    return this.run('Could not list the folders', async () => (await this.client.list()).map(folderOf));
  }

  status(path: string): Promise<FolderStatus> {
    return this.run('Could not read a folder', async () => {
      const status = await this.client.status(path, { messages: true, uidValidity: true });
      if (!status) throw new SourceError(`No status for ${path}`, 'protocol');
      return { messages: status.messages ?? 0, uidValidity: String(status.uidValidity ?? '0') };
    });
  }

  private async open(path: string) {
    const current = this.client.mailbox;
    if (current && current.path === path) return current;
    return this.client.mailboxOpen(path, { readOnly: true });
  }

  listUids(path: string, fromUid: number): Promise<{ uidValidity: string; uids: number[] }> {
    return this.run('Could not list the messages of a folder', async () => {
      const mailbox = await this.open(path);
      const uidValidity = String(mailbox.uidValidity);
      if (!mailbox.exists) return { uidValidity, uids: [] };
      const found = await this.client.search({ uid: `${Math.max(1, fromUid)}:*` }, { uid: true });
      // `n:*` always matches the highest UID, even below n.
      const uids = (found || []).filter((uid) => uid >= fromUid).sort((a, b) => a - b);
      return { uidValidity, uids };
    });
  }

  fetchMeta(path: string, uids: number[]): Promise<MessageMeta[]> {
    return this.run('Could not read messages', async () => {
      if (uids.length === 0) return [];
      await this.open(path);
      const messages = await this.client.fetchAll(uids.join(','), { uid: true, flags: true, internalDate: true, size: true, envelope: true }, { uid: true });
      return messages.map((m) => {
        const messageId = m.envelope?.messageId?.trim().replace(/^<|>$/g, '');
        return {
          uid: m.uid,
          flags: [...(m.flags ?? [])],
          internalDate: m.internalDate instanceof Date ? m.internalDate : new Date(m.internalDate ?? Date.now()),
          size: m.size ?? 0,
          ...(messageId ? { messageId } : {}),
        };
      });
    });
  }

  fetchSource(path: string, uid: number): Promise<Uint8Array> {
    return this.run('Could not read a message', async () => {
      await this.open(path);
      const message = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) throw new SourceError(`Message UID ${uid} is gone`, 'protocol');
      return message.source;
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
