/**
 * The header fields the composer's own send writes and a plugin's send
 * lacks. A crypto plugin that took the send over (onComposeSend: S/MIME,
 * PGP) builds the MIME itself from the request it is handed, which has no
 * Reply-To, read receipt or priority in it. So a signed or encrypted
 * message went out without the identity's Reply-To, without the read
 * receipt the user asked for and without its priority.
 *
 * The host adds them to the top-level header block of what the plugin
 * hands to sendRaw or submitRaw, the way it adds the classification label
 * (classification-raw.ts): outside the signed or encrypted part, so the
 * signature stays valid. A field the plugin wrote itself is left as it is.
 */

import { displayName } from '@/lib/mdn';
import { messagePriorityHeaders } from '@/lib/message-priority';
import { headerEnd } from './classification-raw';
import type { TakeoverSendOptions } from './compose-takeover';

/** An address that can stand in a header as it is: printable ASCII, one "@", none of the characters that end or group an address. */
const ADDRESS = /^[\x21-\x7e]+$/;
const NOT_IN_ADDRESS = /[<>(),;:"\\]/;

function address(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Not repaired: an address with a blank or a control character in it is left out.
  const atom = value.trim();
  if (!ADDRESS.test(atom) || NOT_IN_ADDRESS.test(atom)) return null;
  const at = atom.indexOf('@');
  return at > 0 && at === atom.lastIndexOf('@') && at < atom.length - 1 ? atom : null;
}

/** "Name <address>" for a header, the name encoded or quoted where it has to be. */
function mailbox(entry: { name?: string | null; email: string }): string | null {
  const email = address(entry.email);
  if (!email) return null;
  const name = typeof entry.name === 'string' ? displayName(entry.name) : '';
  return name ? `${name} <${email}>` : email;
}

/** The fields as [name, value], in the order they are written. */
export function takeoverHeaderFields(options: TakeoverSendOptions | null | undefined): Array<[string, string]> {
  if (!options) return [];
  const fields: Array<[string, string]> = [];
  const replyTo = (options.replyTo ?? []).map(mailbox).filter((entry): entry is string => entry !== null);
  if (replyTo.length > 0) fields.push(['Reply-To', replyTo.join(', ')]);
  // RFC 8098: the recipient's client returns a disposition notification to this address.
  const receipt = address(options.readReceiptTo);
  if (receipt) fields.push(['Disposition-Notification-To', receipt]);
  // The same two fields as on the composer's own send (lib/message-priority.ts).
  for (const [property, value] of Object.entries(messagePriorityHeaders(options.priority))) {
    fields.push([property.slice('header:'.length, -':asText'.length), value]);
  }
  return fields;
}

/**
 * What the send asks of the mail server, for the raw send paths: delivery
 * notifications and required TLS, as the composer's own send passes them
 * on. Undefined when it asks for neither.
 */
export function takeoverSubmission(options: TakeoverSendOptions | null | undefined): { requestDsn?: boolean; requireTls?: boolean } | undefined {
  if (!options?.requestDsn && !options?.requireTls) return undefined;
  return { ...(options.requestDsn ? { requestDsn: true } : {}), ...(options.requireTls ? { requireTls: true } : {}) };
}

/** One field as header lines, folded between addresses so no line passes 78 characters where it can be helped. */
function fieldLines(name: string, value: string): string[] {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const part of value.split(', ')) {
    const piece = line.endsWith(':') ? ` ${part}` : `, ${part}`;
    if (line.length + piece.length > 78 && !line.endsWith(':')) {
      lines.push(`${line},`);
      line = ` ${part}`;
    } else {
      line += piece;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * The raw message a plugin hands to sendRaw or submitRaw, with the fields
 * of `options` its header block doesn't have yet. The same bytes when there
 * is nothing to add or the message has no header block.
 */
export function withTakeoverHeaders(bytes: Uint8Array, options: TakeoverSendOptions | null | undefined): Uint8Array {
  const fields = takeoverHeaderFields(options);
  if (fields.length === 0) return bytes;
  const block = headerEnd(bytes);
  if (!block) return bytes;
  // Byte for byte, so 8-bit header bytes (a raw UTF-8 subject) come back unchanged.
  let head = '';
  for (let i = 0; i < block.end; i++) head += String.fromCharCode(bytes[i]);
  const present = new Set<string>();
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon > 0) present.add(line.slice(0, colon).trim().toLowerCase());
  }
  const added = fields.filter(([name]) => !present.has(name.toLowerCase())).flatMap(([name, value]) => fieldLines(name, value));
  if (added.length === 0) return bytes;
  const text = [head, ...added].join(block.eol);
  const newHead = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  const out = new Uint8Array(newHead.length + (bytes.length - block.end));
  out.set(newHead, 0);
  out.set(bytes.subarray(block.end), newHead.length);
  return out;
}
