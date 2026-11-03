/**
 * The engine's way to the real JMAP server. Bulk sync runs in the worker with
 * its own fetch, so large JSON isn't parsed on the main thread. Auth stays
 * with the page: it hands over the header and refreshes it on request.
 */

export type MethodCall = [string, Record<string, unknown>, string];
// Shaped like the server's answer (any per method, as the callers read it).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MethodResponse = [string, any, string];

export interface JmapResponse {
  methodResponses: MethodResponse[];
  sessionState?: string;
}

/** The parts of a JMAP session the engine uses. */
export interface StoreSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { name?: string; isPersonal?: boolean; accountCapabilities?: Record<string, unknown> }>;
  capabilities: Record<string, unknown>;
}

export type TransportFailure = 'network' | 'auth' | 'rate' | 'http';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
    readonly status?: number,
    /** The `type` of an RFC 7807 problem body, when there was one. */
    readonly problem?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface JmapTransport {
  request(calls: MethodCall[], using: string[]): Promise<JmapResponse>;
  download(jmap: string, blobId: string, type: string, name: string): Promise<Uint8Array>;
  /**
   * The same, piece by piece, so a large file isn't held in memory. An error
   * thrown by `sink` ends the download and comes out as it is.
   */
  downloadStream?(jmap: string, blobId: string, type: string, name: string, sink: (part: Uint8Array) => void): Promise<void>;
  upload(jmap: string, data: Uint8Array, type: string): Promise<{ blobId: string; type: string; size: number }>;
}

export interface FetchTransportOptions {
  session(): StoreSession;
  /** The current Authorization header value, or null when the page has none yet. */
  auth(): string | null;
  /** Asks the page for a fresh header; resolves null when it can't get one. */
  refreshAuth(): Promise<string | null>;
  fetch?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 120_000;

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? encodeURIComponent(values[key]) : whole));
}

export class FetchTransport implements JmapTransport {
  constructor(private readonly options: FetchTransportOptions) {}

  private async fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    const send = async (header: string | null): Promise<Response> => {
      if (!header) throw new TransportError('auth', 'No credentials yet');
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      try {
        return await doFetch(url, { ...init, signal, headers: { ...init.headers, Authorization: header } });
      } catch (error) {
        throw new TransportError('network', error instanceof Error ? error.message : 'Network failure');
      }
    };
    let response = await send(this.options.auth());
    if (response.status === 401) {
      response = await send(await this.options.refreshAuth());
      if (response.status === 401) throw new TransportError('auth', 'The server refused the credentials', 401);
    }
    if (response.status === 429 || response.status === 503) {
      const seconds = Number(response.headers.get('Retry-After'));
      throw new TransportError('rate', `Server busy (${response.status})`, response.status, undefined, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
    }
    return response;
  }

  async request(calls: MethodCall[], using: string[]): Promise<JmapResponse> {
    const response = await this.fetchWithAuth(this.options.session().apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    if (!response.ok) {
      let problem: string | undefined;
      try {
        problem = (await response.json() as { type?: string }).type;
      } catch {
        // Not a problem document.
      }
      throw new TransportError('http', `JMAP request failed: ${response.status}`, response.status, problem);
    }
    return await response.json() as JmapResponse;
  }

  async download(jmap: string, blobId: string, type: string, name: string): Promise<Uint8Array> {
    const url = fillTemplate(this.options.session().downloadUrl, { accountId: jmap, blobId, type, name });
    const response = await this.fetchWithAuth(url, { method: 'GET' });
    if (!response.ok) throw new TransportError('http', `Download failed: ${response.status}`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  async upload(jmap: string, data: Uint8Array, type: string): Promise<{ blobId: string; type: string; size: number }> {
    const url = fillTemplate(this.options.session().uploadUrl, { accountId: jmap });
    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': type || 'application/octet-stream' },
      body: data as BodyInit,
    });
    if (!response.ok) throw new TransportError('http', `Upload failed: ${response.status}`, response.status);
    return await response.json() as { blobId: string; type: string; size: number };
  }
}

/** Finds the response to one call. Throws if the server answered it with an error. */
export function responseFor(response: JmapResponse, callId: string): MethodResponse {
  const found = response.methodResponses.find(([name, , id]) => id === callId && name !== 'error');
  if (found) return found;
  const failed = response.methodResponses.find(([, , id]) => id === callId);
  if (failed) throw new JmapMethodError(String(failed[1]?.type ?? 'serverFail'), failed[1]?.description);
  throw new JmapMethodError('serverFail', `No response for call ${callId}`);
}

/** The server answered a call with a method-level error. */
export class JmapMethodError extends Error {
  constructor(readonly type: string, description?: string) {
    super(description ? `${type}: ${description}` : type);
    this.name = 'JmapMethodError';
  }
}
