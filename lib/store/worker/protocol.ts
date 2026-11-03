/** Messages between the page and the store worker. */

import type { StoreEvent, StoreScope } from '../area';
import type { JmapResponse, MethodCall, StoreSession } from '../engine/transport';

export const RPC_CHANNEL = 'bulwark-store-rpc';
export const OWNER_LOCK = 'bulwark-store-owner';

export interface OpenAccountParams {
  account: string;
  /** `/a<hex>.db`, no account data: the name is plaintext in the OPFS slot. */
  file: string;
  /** 32 bytes in hex. Only ever sent to this tab's own worker, never over the channel. */
  keyHex: string;
  session: StoreSession | null;
  scope: StoreScope;
  invertedKeywordSort: boolean;
  /** The page's current Authorization header. */
  auth: string | null;
}

/** What other tabs can ask for, over the channel. */
export interface StoreRpc {
  answer(params: { account: string; calls: MethodCall[] }): JmapResponse | null;
  sync(params: { account: string }): void;
  noteStateChange(params: { account: string; changed: Record<string, Record<string, string>> }): void;
  setOnline(params: { online: boolean }): void;
  status(params: { account: string }): StoreStatus | null;
  /** A non-JMAP call into an area of the store. */
  area(params: { account: string; name: string; params: unknown }): unknown;
}

export interface StoreStatus {
  account: string;
  open: boolean;
  emails: number;
  bodies: number;
  lastSyncedAt: number | null;
}

export type RpcRequest<K extends keyof StoreRpc = keyof StoreRpc> = {
  kind: 'rpc';
  id: string;
  from: string;
  method: K;
  params: Parameters<StoreRpc[K]>[0];
};

export type RpcReply = {
  kind: 'reply';
  id: string;
  to: string;
  result?: unknown;
  error?: string;
};

export type ChannelMessage =
  | RpcRequest
  | RpcReply
  | { kind: 'event'; event: StoreEvent }
  | { kind: 'owner-changed'; owner: string | null };

/** From this tab's page to its own worker, never on the channel. */
export type PageToWorker =
  | { kind: 'init'; clientId: string; moduleUrl: string }
  | { kind: 'open'; id: string; params: OpenAccountParams }
  | { kind: 'close-account'; id: string; account: string }
  | { kind: 'remove-account'; id: string; account: string; file: string }
  | { kind: 'set-auth'; account: string; auth: string | null }
  | { kind: 'set-session'; account: string; session: StoreSession }
  | { kind: 'set-scope'; account: string; scope: StoreScope }
  | { kind: 'release'; id: string };

export type WorkerToPage =
  | { kind: 'owner' }
  | { kind: 'result'; id: string; result?: unknown; error?: string; errorName?: string }
  | { kind: 'need-auth'; account: string }
  | { kind: 'event'; event: StoreEvent };
