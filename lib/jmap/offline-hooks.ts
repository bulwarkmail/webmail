/**
 * Where the JMAP client hands over to offline mode (#523, lib/offline/).
 * The client knows nothing about the cache: it asks these hooks whether to
 * skip the network, gives them what the server answered, and asks them for
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
   * request (then it stays an error).
   */
  serverGone(client: OfflineClientRef): Promise<boolean>;
  /** A blob kept on the device, or null. */
  blob(client: OfflineClientRef, blobId: string, accountId: string): Promise<Blob | null>;
  /** A blob the server sent, for the cache. */
  recordBlob(client: OfflineClientRef, blobId: string, accountId: string, blob: Blob): void;
  /** Keep a file to upload later; the stand-in blob id, or null when offline mode doesn't cover the client. */
  holdUpload(client: OfflineClientRef, file: File, accountId: string): Promise<{ blobId: string; size: number; type: string } | null>;
}

const KEY = '__bulwarkOfflineHooks';

type HookGlobal = typeof globalThis & { [KEY]?: OfflineHooks | null };

export function setOfflineHooks(hooks: OfflineHooks | null): void {
  (globalThis as HookGlobal)[KEY] = hooks;
}

export function getOfflineHooks(): OfflineHooks | null {
  return (globalThis as HookGlobal)[KEY] ?? null;
}

/** The network refused the request (not an HTTP error): offline, DNS, a dropped connection. */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'OfflineUnavailableError') return true;
  return error.name === 'TypeError' && /fetch|network|load failed|internet/i.test(error.message);
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
