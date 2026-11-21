/**
 * Whether a plugin's raw send (api.jmap.sendRaw / submitRaw) completes a
 * send the composer handed it (onComposeSend: S/MIME, PGP). Such a send ran
 * every step at Send, with the user present, so offline mode may keep the
 * finished message in its outbox (#523). A plugin's own sends (a forward, a
 * report) aren't covered and need the server.
 *
 * A raw send counts only when it comes from the plugin whose onComposeSend
 * handler runs right now (lib/plugin-hooks.ts pluginRunsTakeOver) and is
 * for the identity of a takeover the composer opened.
 *
 * The takeover also carries what the composer set in the message's header
 * for a send of its own: the plugin builds the MIME itself and is not told,
 * so the host adds it to what the plugin hands back
 * (lib/outgoing/takeover-headers.ts).
 */

import { generateUUID } from '@/lib/utils';
import { stripCrossAccountIdentityPrefix } from '@/hooks/use-pro-multi-account-identities';
import { pluginRunsTakeOver } from '@/lib/plugin-hooks';
import type { MessagePriority } from '@/lib/message-priority';

/**
 * What the composer's own send writes into the header or asks of the mail
 * server, and a takeover's send gets too.
 */
export interface TakeoverSendOptions {
  /** The sending identity's Reply-To addresses. */
  replyTo?: ReadonlyArray<{ name?: string | null; email: string }> | null;
  /** The address a read receipt goes to, when one is asked for. */
  readReceiptTo?: string;
  /** High or low; normal writes nothing. */
  priority?: MessagePriority;
  /** Ask the next hops for delivery status notifications (RFC 3461). */
  requestDsn?: boolean;
  /** Refuse relaying over an unencrypted hop (RFC 8689). */
  requireTls?: boolean;
}

interface Takeover {
  identityId: string;
  options: TakeoverSendOptions;
}

const open = new Map<string, Takeover>();

const rawId = (identityId: string) => stripCrossAccountIdentityPrefix(identityId).rawId ?? identityId;

/** Called by the composer right before it hands the send to the plugins; pass the token to endComposeTakeover. */
export function beginComposeTakeover(identityId: string, options: TakeoverSendOptions = {}): string {
  const token = generateUUID();
  open.set(token, { identityId: rawId(identityId), options });
  return token;
}

export function endComposeTakeover(token: string): void {
  open.delete(token);
}

/** A raw send from `pluginId` for `identityId` completes an open composer send. */
export function completesComposeTakeover(pluginId: string, identityId: string): boolean {
  if (!pluginRunsTakeOver(pluginId)) return false;
  const id = rawId(identityId);
  return [...open.values()].some((takeover) => takeover.identityId === id);
}

/**
 * The header options of the composer send that a raw send from `pluginId`
 * for `identityId` completes; null when it completes none. The send carries
 * no token to tell two takeovers of one identity apart, so with several
 * open at once the options count only when they all agree.
 */
export function composeTakeoverOptions(pluginId: string, identityId: string): TakeoverSendOptions | null {
  if (!pluginRunsTakeOver(pluginId)) return null;
  const id = rawId(identityId);
  const matching = [...open.values()].filter((takeover) => takeover.identityId === id);
  if (matching.length === 0) return null;
  const first = JSON.stringify(matching[0].options);
  return matching.every((takeover) => JSON.stringify(takeover.options) === first) ? matching[0].options : null;
}

/** For tests. */
export function resetComposeTakeovers(): void {
  open.clear();
}
