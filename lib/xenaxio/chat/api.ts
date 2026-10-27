// Step 43, part B: HTTP to the company's chat server, always through the
// platform's proxy (/api/chat/matrix). The session cookie authenticates; the
// platform adds the chat token, so this code never sees one.
import { apiFetch, withBasePath } from "@/lib/browser-navigation";

/** Where the platform proxies the chat server's client API. */
export const CHAT_BASE = "/api/chat/matrix";

export class ChatError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    message?: string,
  ) {
    super(message ?? errcode);
    this.name = "ChatError";
  }
}

export interface ChatStatus {
  enabled: boolean;
  state: "off" | "provisioning" | "active" | "disabled" | "error";
  address: string | null;
  homeserverUrl: string;
}

/** Is the chat on and ready for the signed-in employee? */
export async function chatStatus(): Promise<ChatStatus> {
  const res = await apiFetch("/api/chat/status", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) throw new ChatError(res.status, "status_failed");
  return (await res.json()) as ChatStatus;
}

export interface CallOptions {
  /** Stops the request (a long poll when the page goes away). */
  signal?: AbortSignal;
  /** Raw body (uploads) instead of JSON. */
  raw?: Blob;
}

/** One call to the chat server's client API; `path` starts with /_matrix/. */
export async function mx<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: CallOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(`${CHAT_BASE}${path}`, {
      method,
      credentials: "same-origin",
      signal: opts.signal,
      headers: {
        Accept: "application/json",
        // CSRF guard of the platform (as for every write through /api).
        "x-xenaxio-csrf": "1",
        ...(opts.raw ? { "Content-Type": opts.raw.type || "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.raw ? { body: opts.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw err;
    throw new ChatError(0, "M_NETWORK");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ChatError(res.status, typeof data.errcode === "string" ? data.errcode : "M_UNKNOWN", typeof data.error === "string" ? data.error : undefined);
  return data as T;
}

const enc = encodeURIComponent;

/** "mxc://server/id" → [server, id], or null for anything else. */
export function parseMxc(mxc: string | undefined | null): [string, string] | null {
  const m = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(mxc ?? "");
  return m ? [m[1] as string, m[2] as string] : null;
}

/**
 * Address of a chat file for <img src> or a download link. The browser sends
 * the session cookie; the platform adds the chat token.
 */
export function mediaUrl(mxc: string | undefined | null, opts: { thumbnail?: { width: number; height: number }; filename?: string } = {}): string | null {
  const parts = parseMxc(mxc);
  if (!parts) return null;
  const [server, id] = parts;
  const base = `${CHAT_BASE}/_matrix/client/v1/media`;
  if (opts.thumbnail) return withBasePath(`${base}/thumbnail/${enc(server)}/${enc(id)}?width=${opts.thumbnail.width}&height=${opts.thumbnail.height}&method=scale`);
  return withBasePath(`${base}/download/${enc(server)}/${enc(id)}${opts.filename ? `/${enc(opts.filename)}` : ""}`);
}

/** Uploads a file; returns its mxc:// address. */
export async function uploadFile(file: Blob, name: string): Promise<string> {
  const res = await mx<{ content_uri: string }>("POST", `/_matrix/media/v3/upload?filename=${enc(name)}`, undefined, { raw: file });
  return res.content_uri;
}

let txnCounter = 0;
/** Transaction id of a message: the chat server ignores a repeat with the same id. */
export function newTxnId(): string {
  txnCounter += 1;
  return `x${Date.now().toString(36)}${txnCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const paths = {
  sync: "/_matrix/client/v3/sync",
  whoami: "/_matrix/client/v3/account/whoami",
  createRoom: "/_matrix/client/v3/createRoom",
  publicRooms: "/_matrix/client/v3/publicRooms",
  search: "/_matrix/client/v3/search",
  userDirectory: "/_matrix/client/v3/user_directory/search",
  join: (room: string) => `/_matrix/client/v3/join/${enc(room)}`,
  leave: (room: string) => `/_matrix/client/v3/rooms/${enc(room)}/leave`,
  invite: (room: string) => `/_matrix/client/v3/rooms/${enc(room)}/invite`,
  send: (room: string, type: string, txn: string) => `/_matrix/client/v3/rooms/${enc(room)}/send/${enc(type)}/${enc(txn)}`,
  redact: (room: string, event: string, txn: string) => `/_matrix/client/v3/rooms/${enc(room)}/redact/${enc(event)}/${enc(txn)}`,
  state: (room: string, type: string, key = "") => `/_matrix/client/v3/rooms/${enc(room)}/state/${enc(type)}/${enc(key)}`,
  messages: (room: string) => `/_matrix/client/v3/rooms/${enc(room)}/messages`,
  members: (room: string) => `/_matrix/client/v3/rooms/${enc(room)}/members`,
  context: (room: string, event: string) => `/_matrix/client/v3/rooms/${enc(room)}/context/${enc(event)}`,
  relations: (room: string, event: string, relType: string) => `/_matrix/client/v1/rooms/${enc(room)}/relations/${enc(event)}/${enc(relType)}`,
  threads: (room: string) => `/_matrix/client/v1/rooms/${enc(room)}/threads`,
  receipt: (room: string, event: string) => `/_matrix/client/v3/rooms/${enc(room)}/receipt/m.read/${enc(event)}`,
  readMarkers: (room: string) => `/_matrix/client/v3/rooms/${enc(room)}/read_markers`,
  typing: (room: string, user: string) => `/_matrix/client/v3/rooms/${enc(room)}/typing/${enc(user)}`,
  presence: (user: string) => `/_matrix/client/v3/presence/${enc(user)}/status`,
  accountData: (user: string, type: string) => `/_matrix/client/v3/user/${enc(user)}/account_data/${enc(type)}`,
  roomAccountData: (user: string, room: string, type: string) => `/_matrix/client/v3/user/${enc(user)}/rooms/${enc(room)}/account_data/${enc(type)}`,
  tag: (user: string, room: string, tag: string) => `/_matrix/client/v3/user/${enc(user)}/rooms/${enc(room)}/tags/${enc(tag)}`,
  pushRules: "/_matrix/client/v3/pushrules/",
  pushRule: (kind: string, id: string) => `/_matrix/client/v3/pushrules/global/${enc(kind)}/${enc(id)}`,
  profile: (user: string) => `/_matrix/client/v3/profile/${enc(user)}`,
};

/** Step 43, part E: reports a message to the company's admins (spam, abuse from outside). */
export async function reportMessage(report: { roomId: string; eventId: string; sender: string; excerpt: string; reason: string }): Promise<void> {
  const res = await apiFetch("/api/chat/report", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "x-xenaxio-csrf": "1" },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new ChatError(res.status, "report_failed");
}
