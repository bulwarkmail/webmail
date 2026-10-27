// Client for the xenaxio assistant (/api/ai): server-sent events over fetch,
// so the request can carry the session cookie, a JSON body and the CSRF header.
import { apiFetch } from "@/lib/browser-navigation";
import { buildFilesPath } from "@/lib/deep-links";
import { XenaxioApiError } from "./api";

export interface SourceEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string[];
  receivedAt?: string;
}

/** What the assistant proposes to create or change (I5); runs only after "Bestätigen". */
export interface ProposalSummary {
  title?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string;
  attendees?: string[];
  /** Names of the user's files attached to the meeting (step 34). */
  files?: string[];
  /** update_event only: what changes, who is newly invited, and the meeting as it was. */
  changes?: string[];
  addedAttendees?: string[];
  before?: { title?: string; start?: string; end?: string; location?: string; due?: string | null; priority?: string; status?: string; reminder?: boolean };
  /** Step 47: how the meeting repeats (in the user's language), what part of a series changes. */
  repeatText?: string;
  repeatBefore?: string;
  scope?: "occurrence" | "series";
  /** The occurrence's original start ("2026-11-02T10:00"). */
  occurrence?: string;
  /** Changed occurrences that go back to the series when it moves. */
  resetsChangedOccurrences?: number;
  /** remember and forget (step 36): the note, and the note it replaces. */
  text?: string;
  replaces?: string;
  /** create_task and update_task (step 46): the task as it will be. */
  due?: string | null;
  allDay?: boolean;
  priority?: "high" | "medium" | "low" | "none";
  reminder?: boolean;
  description?: string;
  status?: "open" | "in-progress" | "done" | "cancelled";
  /** create_task from an email: the email it links to. */
  email?: { subject: string; from: string };
}

export interface ActionResult {
  status: "done";
  result: { eventId?: string; invited?: string[]; invitationSent?: boolean };
}

export type AssistantEvent =
  | { type: "start"; conversationId?: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error" }
  | { type: "sources"; emails: SourceEmail[] }
  | { type: "proposal"; id: string; tool: string; summary: ProposalSummary }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: string }
  /** Step 45: the company's own model did not answer; the AI by xenaxio answered instead. */
  | { type: "notice"; code: "custom_model_fallback" };

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json", "x-xenaxio-csrf": "1" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw err;
    throw new XenaxioApiError(0, "network");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new XenaxioApiError(res.status, data.error ?? "internal");
  }
  return res;
}

/** Parses an SSE body into events; stops when the stream ends or is aborted. */
export async function* readEvents(res: Response): AsyncGenerator<AssistantEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as AssistantEvent;
      } catch {
        // Ignore a malformed event; the next one may be fine.
      }
    }
  }
}

/** Step 33: a file attached to a chat message; kept in the user's files. */
export interface AttachedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Path in the user's own files; absent for files colleagues shared. */
  path?: string;
  /** Removed from Files since (only on a chat loaded from the history). */
  deleted?: boolean;
}

/** Limits of the platform: files per message, bytes per file, bytes per picture the model sees. */
export const MAX_CHAT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isChatImage = (type: string) => MODEL_IMAGE_TYPES.has(type);

/** Why a file cannot go into the chat, as a message key, or null when it can. */
export function chatFileProblem(file: { size: number; type: string }): "attach_too_large" | "attach_image_too_large" | null {
  if (file.size > MAX_CHAT_FILE_BYTES) return "attach_too_large";
  if (isChatImage(file.type) && file.size > MAX_CHAT_IMAGE_BYTES) return "attach_image_too_large";
  return null;
}

/** Name of a picture pasted from the clipboard: "Bild 2026-10-25 14-03.png". */
export function pastedName(label: string, type: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ext = type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";
  return `${label} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}.${ext}`;
}

/** Where Files shows an attached file, or null when it cannot be linked (shared or deleted). */
export function attachedFileLink(file: AttachedFile): string | null {
  if (!file.path || file.deleted || file.id.includes(":")) return null;
  const folder = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
  return buildFilesPath(folder, file.name);
}

export interface ChatContext {
  emailId?: string;
  threadId?: string;
}

export const assistant = {
  async status(): Promise<{ configured: boolean; enabled: boolean; usage?: { warning: boolean; blocked: boolean } }> {
    const res = await apiFetch("/api/ai/status", { credentials: "same-origin" });
    if (!res.ok) return { configured: false, enabled: false };
    return res.json();
  },
  async *chat(message: string, conversationId: string | undefined, context: ChatContext, signal?: AbortSignal, fileIds: string[] = []) {
    yield* readEvents(await post("/api/ai/chat", { message, ...(conversationId ? { conversationId } : {}), ...(fileIds.length ? { fileIds } : {}), context }, signal));
  },
  /** Step 33: puts a file into the user's chat folder in Files and returns it for the next message. */
  async upload(file: Blob, name: string): Promise<AttachedFile> {
    let res: Response;
    try {
      res = await apiFetch("/api/ai/files", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(name), Accept: "application/json", "x-xenaxio-csrf": "1" },
        body: file,
      });
    } catch {
      throw new XenaxioApiError(0, "network");
    }
    const data = (await res.json().catch(() => ({}))) as { file?: AttachedFile; error?: string };
    if (!res.ok || !data.file) throw new XenaxioApiError(res.status, res.status === 413 ? "file_too_large" : (data.error ?? "internal"));
    return data.file;
  },
  async *summarize(threadId: string, signal?: AbortSignal) {
    yield* readEvents(await post("/api/ai/summarize", { threadId }, signal));
  },
  async reply(emailId: string, instructions = ""): Promise<{ draftId: string; threadId?: string }> {
    return (await post("/api/ai/reply", { emailId, instructions })).json();
  },
  async confirm(actionId: string): Promise<ActionResult> {
    return (await post(`/api/ai/actions/${encodeURIComponent(actionId)}/confirm`, {})).json();
  },
  async reject(actionId: string): Promise<void> {
    await post(`/api/ai/actions/${encodeURIComponent(actionId)}/reject`, {});
  },
  async conversations(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const res = await apiFetch("/api/ai/conversations", { credentials: "same-origin" });
    return res.ok ? (await res.json()).conversations : [];
  },
  async messages(id: string): Promise<{ role: "user" | "assistant"; content: string; files?: AttachedFile[] }[]> {
    const res = await apiFetch(`/api/ai/conversations/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    return res.ok ? (await res.json()).messages : [];
  },
  async remove(id?: string): Promise<void> {
    await apiFetch(id ? `/api/ai/conversations/${encodeURIComponent(id)}` : "/api/ai/conversations", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-xenaxio-csrf": "1" },
    });
  },
};

/**
 * Step 31: ids of an email for the assistant. Mail of another account (a
 * shared mailbox, info@) carries that account in front (`<account>:<id>`), as
 * the platform's tools expect; the web client marks such mail by namespacing
 * its mailbox ids the same way.
 */
export function assistantIds(email: { id: string; threadId: string; mailboxIds?: Record<string, boolean> | null }): { emailId: string; threadId: string } {
  const key = Object.keys(email.mailboxIds ?? {})[0] ?? "";
  const sep = key.indexOf(":");
  const prefix = sep > 0 ? `${key.slice(0, sep)}:` : "";
  return { emailId: `${prefix}${email.id}`, threadId: `${prefix}${email.threadId}` };
}

/** The web client's own id of a cited email (without the account the assistant adds). */
export function messageRouteId(id: string): string {
  const sep = id.indexOf(":");
  return sep > 0 ? id.slice(sep + 1) : id;
}

/** Events between the assistant UI and the mail app (no shared imports needed). */
export const OPEN_DRAFT_EVENT = "xenaxio:open-draft";
export const ASSISTANT_COMMAND_EVENT = "xenaxio:assistant";

export type AssistantCommand =
  | { action: "open" }
  | { action: "summarize"; threadId: string; subject?: string }
  | { action: "reply" }
  /** Step 43, part D: a question asked for the user (e.g. "summarize this chat thread"). */
  | { action: "ask"; text: string };

let availability: Promise<boolean> | null = null;
/** Whether the assistant is configured and enabled for this user (asked once per page load). */
export function assistantAvailable(): Promise<boolean> {
  availability ??= assistant
    .status()
    .then((s) => s.configured && s.enabled)
    .catch(() => false);
  return availability;
}

export function sendAssistantCommand(command: AssistantCommand): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_COMMAND_EVENT, { detail: command }));
}

/** Per-tab copy of the open assistant chat (see AssistantPanel). */
export const ASSISTANT_STORAGE_KEY = "xenaxio.assistant";

/** Called on sign-out so the next person in this tab never sees the chat. */
export function clearAssistantState(): void {
  try {
    sessionStorage.removeItem(ASSISTANT_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing stored.
  }
}
