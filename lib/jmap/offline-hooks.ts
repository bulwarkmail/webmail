/**
 * Where the JMAP client hands over to offline mode (#523, lib/offline/).
 * The client knows nothing about the local store: it asks these hooks whether
 * to skip the network, gives them what the server answered, and asks them for
 * an answer when the network is gone. Nothing is registered while offline
 * mode is off for every account, so the client then behaves as before.
 *
 * Kept on globalThis: Next can bundle the client module more than once, and
 * every copy has to find the same hooks.
 */

export type OfflineMethodCall = [string, Record<string, unknown>, string];
export interface OfflineResponse {
  // Shaped like the server's answer (any per method, as the client reads it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methodResponses: Array<[string, any, string]>;
}

/** What the hooks need to know about the client asking. */
export interface OfflineClientRef {
  /** Server URL and login, to find the Bulwark account. */
  getServerUrl(): string;
  getUsername(): string;
  getAccountId(): string;
  /** Answers from this device only: a local copy on screen at a start. */
  isOfflineOnly?(): boolean;
}

export interface OfflineHooks {
  /** Answer without trying the network: the browser says it is offline (or the client was started offline). */
  skipNetwork(client: OfflineClientRef): boolean;
  /** An answer from the device for a request the network couldn't take, or null. */
  answer(client: OfflineClientRef, methodCalls: OfflineMethodCall[]): Promise<OfflineResponse | null>;
  /** What the server answered, for the cache. */
  record(client: OfflineClientRef, methodCalls: OfflineMethodCall[], response: OfflineResponse): void;
  /** A request reached the server (true) or failed on the network (false). */
  noteNetwork(client: OfflineClientRef, reachable: boolean): void;
  /**
   * After a request failed on the network: whether the server can't be
   * reached at all (then the device answers), or it only refused that
   * request (then it stays an error). `error` is what the request failed with.
   */
  serverGone(client: OfflineClientRef, error?: unknown): Promise<boolean>;
  /** The server pushed new states, for the local store to catch up. */
  stateChange?(client: OfflineClientRef, change: { changed?: Record<string, Record<string, string>> }): void;
  /** A blob kept on the device, or null. */
  blob(client: OfflineClientRef, blobId: string, accountId: string): Promise<Blob | null>;
  /** A blob the server sent, for the cache. */
  recordBlob(client: OfflineClientRef, blobId: string, accountId: string, blob: Blob): void;
  /** Keep a file to upload later; the stand-in blob id, or null when offline mode doesn't cover the client. */
  holdUpload(client: OfflineClientRef, file: File, accountId: string): Promise<{ blobId: string; size: number; type: string } | null>;
  /**
   * Search calls answered from the local store while the server is asked too
   * (lib/jmap/search-merge.ts). Null when the store doesn't cover the client.
   * Left out when there is no store, and searches then go to the server alone.
   */
  searchLocal?(client: OfflineClientRef, methodCalls: OfflineMethodCall[]): Promise<OfflineResponse | null>;
  /**
   * Real ids for stand-in ids the page still holds (lib/jmap/stand-in-ids.ts), or
   * null for one that hasn't reached the server yet. Without it the client sends
   * ids as they are.
   */
  resolveStandIns?(client: OfflineClientRef, ids: string[]): Promise<Record<string, string | null>>;
  /** The user opened this file: the local store keeps recently opened files. */
  fileOpened?(client: OfflineClientRef, accountId: string, id: string): void;
}

const KEY = '__bulwarkOfflineHooks';

type HookGlobal = typeof globalThis & { [KEY]?: OfflineHooks | null };

export function setOfflineHooks(hooks: OfflineHooks | null): void {
  (globalThis as HookGlobal)[KEY] = hooks;
}

export function getOfflineHooks(): OfflineHooks | null {
  return (globalThis as HookGlobal)[KEY] ?? null;
}

/**
 * The server can't be talked to: offline, DNS, a dropped connection, a request
 * that hung until its deadline, a proxy answering for a server that's down.
 * Not an answer from the server itself.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'OfflineUnavailableError' || error.name === 'RequestTimeoutError' || error.name === 'GatewayError') return true;
  return error.name === 'TypeError' && /fetch|network|load failed|internet/i.test(error.message);
}

/** The connection is fine and a proxy answered: the mail server behind it is what's gone. */
export function isServerOutage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'GatewayError') return true;
  return error.name === 'SendNotStartedError' && (error as SendNotStartedError).cause instanceof Error && ((error as SendNotStartedError).cause as Error).name === 'GatewayError';
}

/** Thrown for a request the device can't answer while the server can't be reached. */
export class OfflineUnavailableError extends Error {
  constructor(message = 'Not available offline') {
    super(message);
    this.name = 'OfflineUnavailableError';
  }
}

/**
 * A send failed before its submission request reached the network: nothing
 * left, so the offline outbox may keep it and try again (#523). Any other
 * failure of a send may have come after the server took the message.
 */
export class SendNotStartedError extends Error {
  constructor(readonly cause?: unknown) {
    super(cause instanceof Error ? cause.message : 'The send did not start');
    this.name = 'SendNotStartedError';
  }
}
