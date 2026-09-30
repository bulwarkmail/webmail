import { createHash } from 'node:crypto';
import { encryptPayload, decryptPayload } from '@/lib/auth/crypto';

/**
 * WOPI access tokens (#425).
 *
 * The WOPI client (Collabora / OnlyOffice / EuroOffice, ...) receives this
 * token in the launch form POST and echoes it back on every WOPI call
 * (CheckFileInfo, GetFile, PutFile). It is an AES-256-GCM blob keyed off
 * SESSION_SECRET - opaque to the editor - carrying the stored Stalwart
 * credentials plus the one document it is scoped to: a Files node, or a mail
 * attachment blob opened read-only (#1047). The editor can therefore only
 * reach the /api/wopi/files/<documentId> surface for that document, never
 * the JMAP server itself.
 */

export type WopiDocumentKind = 'file' | 'attachment';

export interface WopiTokenPayload {
  serverUrl: string;
  authHeader: string;
  username: string;
  accountId: string;
  /** FileNode id for 'file', blobId for 'attachment'. */
  fileId: string;
  /** Absent on tokens minted before attachments existed - those are files. */
  kind?: WopiDocumentKind;
  /**
   * Attachment metadata. A blob has no name/type/size of its own, so the
   * launch route records them for CheckFileInfo/GetFile.
   */
  name?: string;
  type?: string;
  size?: number;
  /**
   * Account PutFile uploads new content into: the login's own. For a node
   * shared with the user, `accountId` is the owner's, and Stalwart doesn't
   * let the user reference a blob they uploaded there (#1094). Absent on
   * older tokens - those upload into `accountId`.
   */
  uploadAccountId?: string;
  canWrite: boolean;
  /** Browser origin that embeds the editor iframe (WOPI PostMessageOrigin). */
  origin: string;
  /**
   * The browser and account slot that minted the token, so signing out
   * there revokes it (see lib/wopi/revocation.ts). Absent on older tokens.
   */
  bid?: string;
  slot?: number;
  /** Expiry, ms since epoch. */
  exp: number;
}

export const WOPI_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

// The token travels as a form field and is re-embedded into URLs by the
// editor. Standard base64 breaks on that trip: '+' decodes to a space under
// x-www-form-urlencoded rules and '/' needs escaping, so the token is issued
// in the URL-safe alphabet (base64url) instead.
function toBase64Url(token: string): string {
  return token.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  // Also map stray spaces back to '+' in case an intermediary applied
  // form-urlencoded decoding to a legacy standard-base64 token.
  return token.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
}

/**
 * The id in the WOPISrc URL (/api/wopi/files/<id>). WOPI clients key their
 * open-document sessions by WOPISrc, so the raw FileNode id or blobId is not
 * enough: ids like "b" repeat in every account, and a second user opening
 * their own "b" would be joined into the first user's session and served
 * that document. Hashing in the server and account keeps the id unique per
 * document while two people on a shared account still co-edit one session.
 */
export function wopiDocumentId(
  p: Pick<WopiTokenPayload, 'serverUrl' | 'accountId' | 'fileId' | 'kind'>,
): string {
  return createHash('sha256')
    .update([p.kind ?? 'file', p.serverUrl, p.accountId, p.fileId].join('\n'))
    .digest('base64url')
    .slice(0, 32);
}

export function mintWopiToken(payload: Omit<WopiTokenPayload, 'exp'>): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + WOPI_TOKEN_TTL_MS;
  const token = toBase64Url(encryptPayload({ v: 1, t: 'wopi', ...payload, exp: expiresAt }, 'wopi-token'));
  return { token, expiresAt };
}

/**
 * Decrypt and validate a WOPI access token. `documentId` is the id from the
 * request URL; it must be the token's own wopiDocumentId so a token for one
 * document cannot address another.
 */
export function verifyWopiToken(token: string | null, documentId: string): WopiTokenPayload | null {
  if (!token) return null;
  const raw = decryptPayload(fromBase64Url(token), 'wopi-token');
  if (!raw || raw.v !== 1 || raw.t !== 'wopi') return null;
  const p = raw as unknown as WopiTokenPayload;
  if (
    typeof p.serverUrl !== 'string' || !p.serverUrl ||
    typeof p.authHeader !== 'string' || !p.authHeader ||
    typeof p.accountId !== 'string' || !p.accountId ||
    typeof p.fileId !== 'string' || !p.fileId ||
    typeof p.exp !== 'number'
  ) return null;
  if (p.kind !== undefined && p.kind !== 'file' && p.kind !== 'attachment') return null;
  if (p.bid !== undefined && typeof p.bid !== 'string') return null;
  if (p.slot !== undefined && typeof p.slot !== 'number') return null;
  if (p.uploadAccountId !== undefined && (typeof p.uploadAccountId !== 'string' || !p.uploadAccountId)) return null;
  if (wopiDocumentId(p) !== documentId) return null;
  if (Date.now() > p.exp) return null;
  return p;
}
