/**
 * Classification labels on raw sends (api.jmap.sendRaw and submitRaw), the
 * way S/MIME and PGP plugins send after they took the send over from the
 * composer (onComposeSend). They build the MIME themselves, so the host
 * puts the label into the top-level header block of what they hand it,
 * outside the signed or encrypted part.
 *
 * - The composer registers each takeover before it runs
 *   (beginLabelTakeover) and hands the plugin its `labelToken` in the
 *   request. A raw send that passes the token back gets that takeover's
 *   label. Plugins that don't pass it yet are matched by their sending
 *   identity; with more than one takeover open for it, the send is refused
 *   rather than guessed.
 * - While the organisation uses labels, label headers a plugin wrote itself
 *   are always taken out.
 * - A raw send outside any takeover gets the default label, and is refused
 *   when a label is required: it can't carry the user's pick.
 */

import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { labelHeaderLines, type LabelsPolicy } from '@/lib/classification/labels';
import { stripCrossAccountIdentityPrefix } from '@/hooks/use-pro-multi-account-identities';
import { generateUUID } from '@/lib/utils';
import { labelsPolicyFor } from './classification';
import { LABEL_HEADER_NAMES } from './custom-headers';

interface Takeover {
  identityId: string;
  /** The label's header lines; empty for "no label". */
  lines: string[];
}

const takeovers = new Map<string, Takeover>();

/** An identity id without the "<account>::" prefix of another signed-in account's identities. */
function rawIdentityId(identityId: string): string {
  return stripCrossAccountIdentityPrefix(identityId).rawId ?? identityId;
}

/** A raw send the host refuses; the plugin gets the message. */
export class RawSendLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawSendLabelError';
  }
}

/**
 * Registers a takeover about to run, with the label the message goes out
 * with (null: none). Returns the token to put in the request and to pass
 * to endLabelTakeover when the takeover ended; null while labels are off.
 */
export function beginLabelTakeover(
  policy: LabelsPolicy,
  label: ClassificationLabel | null,
  identityId: string,
): string | null {
  if (policy.list.length === 0) return null;
  const token = generateUUID();
  takeovers.set(token, { identityId: rawIdentityId(identityId), lines: label ? labelHeaderLines(label, policy.extraHeader) : [] });
  return token;
}

export function endLabelTakeover(token: string | null): void {
  if (token) takeovers.delete(token);
}

/** For tests. */
export function resetLabelTakeovers(): void {
  takeovers.clear();
}

/** The header lines a raw send gets: its takeover's, or the default's outside one. */
function linesFor(policy: LabelsPolicy, identityId: string, token: string | undefined): string[] {
  if (token) {
    const takeover = takeovers.get(token);
    if (!takeover) throw new RawSendLabelError('This send is no longer open in the composer. Send the message again.');
    return takeover.lines;
  }
  const id = rawIdentityId(identityId);
  const open = [...takeovers.values()].filter((t) => t.identityId === id);
  if (open.length === 1) return open[0].lines;
  if (open.length > 1) {
    throw new RawSendLabelError('Several messages are being sent from this address at once, and this one can\'t be matched to its classification label. Send it again.');
  }
  if (policy.required) {
    throw new RawSendLabelError('Your organisation requires a classification label, and a message sent outside the composer can\'t carry one.');
  }
  const fallback = policy.list.find((label) => label.id === policy.defaultId);
  return fallback ? labelHeaderLines(fallback, policy.extraHeader) : [];
}

/** Where the header block of raw message bytes ends, and its line break. */
function headerEnd(bytes: Uint8Array): { end: number; eol: string } | null {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) return { end: i, eol: '\r\n' };
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return { end: i, eol: '\n' };
  }
  return null;
}

/**
 * The raw message a plugin hands to sendRaw or submitRaw, with the label
 * the organisation's policy (of the active account, which sends it) asks
 * for. The same bytes while labels are off. Throws RawSendLabelError when
 * the send has to be refused.
 */
export function labelRawSend(bytes: Uint8Array, identityId: string, token?: string): Uint8Array {
  const policy = labelsPolicyFor({});
  if (policy.list.length === 0) return bytes;
  const lines = linesFor(policy, identityId, typeof token === 'string' && token ? token : undefined);
  const block = headerEnd(bytes);
  if (!block) throw new RawSendLabelError('The message has no header block.');
  // Byte for byte, so 8-bit header bytes (a raw UTF-8 subject) come back unchanged.
  let head = '';
  for (let i = 0; i < block.end; i++) head += String.fromCharCode(bytes[i]);
  const reserved = new Set<string>([...LABEL_HEADER_NAMES, ...(policy.extraHeader ? [policy.extraHeader.toLowerCase()] : [])]);
  const kept: string[] = [];
  let skipping = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = reserved.has(line.slice(0, line.indexOf(':')).trim().toLowerCase());
    if (!skipping) kept.push(line);
  }
  const text = [...kept, ...lines.map((line) => line.replace(/\r\n/g, block.eol))].join(block.eol);
  const newHead = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  const out = new Uint8Array(newHead.length + (bytes.length - block.end));
  out.set(newHead, 0);
  out.set(bytes.subarray(block.end), newHead.length);
  return out;
}
