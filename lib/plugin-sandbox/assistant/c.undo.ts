// Undo tokens for area c (email.batch, filters.create, calendar.deleteEvent,
// app.setSettings). What an undo needs stays in the host: the plugin only
// gets a random token, bound to its id and the signed-in account, good for
// 30 minutes. So a plugin can take back what it did, but can never hand the
// host a copy of something to re-create.

import { generateUUID } from '../../utils';
import type { IJMAPClient } from '../../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';

/** How long an undo token can be used. */
export const UNDO_TOKEN_TTL_MS = 30 * 60_000;
/** Most tokens kept per plugin; the oldest go first. */
const MAX_TOKENS_PER_PLUGIN = 50;

interface Entry {
  pluginId: string;
  accountId: string;
  kind: string;
  expires: number;
  data: unknown;
}

const tokens = new Map<string, Entry>();

function prune(now: number): void {
  for (const [token, entry] of tokens) if (entry.expires <= now) tokens.delete(token);
}

/** Keeps `data` for an undo of `kind` and returns its token. */
export function issueUndoToken(pluginId: string, accountId: string, kind: string, data: unknown): string {
  const now = Date.now();
  prune(now);
  const mine = [...tokens].filter(([, e]) => e.pluginId === pluginId);
  for (const [token] of mine.slice(0, Math.max(0, mine.length - MAX_TOKENS_PER_PLUGIN + 1))) tokens.delete(token);
  const token = generateUUID();
  tokens.set(token, { pluginId, accountId, kind, expires: now + UNDO_TOKEN_TTL_MS, data });
  return token;
}

/**
 * Takes the data of a token: only for the plugin that got it, in the same
 * account, for the same kind, before it ran out. A token works once.
 */
export function redeemUndoToken<T>(method: string, pluginId: string, accountId: string, kind: string, token: unknown): T {
  if (typeof token !== 'string' || !token) throw new Error(`${method}: undoToken must be a string`);
  const entry = tokens.get(token);
  prune(Date.now());
  if (!entry || entry.expires <= Date.now() || entry.pluginId !== pluginId || entry.accountId !== accountId || entry.kind !== kind) {
    throw new Error(`${method}: this can't be undone any more`);
  }
  tokens.delete(token);
  return entry.data as T;
}

/** The account an undo token is bound to: the client's JMAP account, else the signed-in login. */
export function undoAccount(client: IJMAPClient): string {
  return client.getAccountId?.() || useAuthStore.getState().activeAccountId || '';
}

/** For tests. */
export function clearUndoTokens(): void {
  tokens.clear();
}
