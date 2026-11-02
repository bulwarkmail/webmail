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
 */

import { generateUUID } from '@/lib/utils';
import { stripCrossAccountIdentityPrefix } from '@/hooks/use-pro-multi-account-identities';
import { pluginRunsTakeOver } from '@/lib/plugin-hooks';

const open = new Map<string, string>();

const rawId = (identityId: string) => stripCrossAccountIdentityPrefix(identityId).rawId ?? identityId;

/** Called by the composer right before it hands the send to the plugins; pass the token to endComposeTakeover. */
export function beginComposeTakeover(identityId: string): string {
  const token = generateUUID();
  open.set(token, rawId(identityId));
  return token;
}

export function endComposeTakeover(token: string): void {
  open.delete(token);
}

/** A raw send from `pluginId` for `identityId` completes an open composer send. */
export function completesComposeTakeover(pluginId: string, identityId: string): boolean {
  if (!pluginRunsTakeOver(pluginId)) return false;
  return [...open.values()].includes(rawId(identityId));
}

/** For tests. */
export function resetComposeTakeovers(): void {
  open.clear();
}
