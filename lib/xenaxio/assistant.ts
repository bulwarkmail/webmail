// Client for the xenaxio assistant (/api/ai): server-sent events over fetch,
// so the request can carry the session cookie, a JSON body and the CSRF header.
import { apiFetch } from "@/lib/browser-navigation";
import { buildFilesPath } from "@/lib/deep-links";
import { XenaxioApiError } from "./api";
import { clearCachedPositions } from "@/lib/xenaxio/assistant-position";

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
  /** Step 78: the event gets a Xenaxio Meeting (video link). */
  meeting?: boolean;
  /** Step 79, part D: the event is a Xenaxio Webinar; viewers register unless registration is false. */
  webinar?: boolean;
  registration?: boolean;
  attendees?: string[];
  /** Names of the user's files attached to the meeting (step 34). */
  files?: string[];
  /** update_event only: what changes, who is newly invited, and the meeting as it was. */
  changes?: string[];
  addedAttendees?: string[];
  before?: { title?: string; start?: string; end?: string; location?: string; due?: string | null; priority?: string; status?: string; reminder?: boolean; when?: string; emailCopy?: boolean; maySend?: boolean; sendTo?: string[] };
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
  /** Tasks: open | in-progress | done | cancelled; scheduled tasks (step 49): active | paused | ended. */
  status?: "open" | "in-progress" | "done" | "cancelled" | "active" | "paused" | "ended";
  /** create_task from an email: the email it links to. */
  email?: { subject: string; from: string };
  /** schedule_task, update_schedule, delete_schedule (step 49). */
  scheduleId?: string;
  instruction?: string;
  when?: string;
  nextRuns?: string[];
  emailCopy?: boolean;
  maySend?: boolean;
  sendTo?: string[];
  /** delete_draft (step 69): the draft that would be deleted. */
  draftId?: string;
  subject?: string;
  to?: string[];
  preview?: string;
  attachments?: string[];
  /** Step 85: a tool that waits only because the user wants to be asked: its name and input. */
  tool?: string;
  input?: Record<string, unknown>;
}

/** Step 49: a chat in the history; scheduled tasks have their own, unread until opened. */
export interface ConversationInfo {
  id: string;
  title: string;
  updatedAt: string;
  scheduled?: boolean;
  unread?: boolean;
}

/** Step 49: proposals of a scheduled run still waiting for the user's click in that chat. */
export interface WaitingProposal {
  id: string;
  tool: string;
  summary: ProposalSummary;
}

/** Step 49: a link (push, email copy) opens this chat in the panel: ?assistant=<id>. */
export const ASSISTANT_OPEN_PARAM = "assistant";
/** Step 85: ?assistant=waiting opens what connected AI chats wait for. */
export const ASSISTANT_WAITING = "waiting";

/** Step 85: a call of a connected AI chat (MCP) waiting for the user's confirmation. */
export interface WaitingAction extends WaitingProposal {
  /** The connection's name, as on "KI-Chats verbinden". */
  client: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ActionResult {
  status: "done";
  /** Step 49: calendarId — the "KI-Aufgaben" calendar a scheduled task shows in. */
  result: { eventId?: string; invited?: string[]; invitationSent?: boolean; calendarId?: string };
}

export type AssistantEvent =
  | { type: "start"; conversationId?: string }
  | { type: "text"; text: string }
  /** `agent` (step 120): the call was made by one of the assistant's helpers. */
  | { type: "tool"; name: string; status: "start" | "done" | "error"; agent?: string }
  /** Step 120: a helper started or finished its part of the work. */
  | { type: "delegate"; agent: string; status: "start" | "done" | "error" }
  | { type: "sources"; emails: SourceEmail[] }
  | { type: "proposal"; id: string; tool: string; summary: ProposalSummary }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: string }
  /** Step 45: the company's own model did not answer; the AI by xenaxio answered instead. Step 83: the older chat was summarised. */
  | { type: "notice"; code: "custom_model_fallback" | "history_summarized" }
  /** Step 83 (Xenacore): the plan of a longer task, shown as a checklist. */
  | { type: "plan"; items: PlanItem[] }
  /** Step 83 (Xenacore): the answer stopped at the company's limit; "Weiter" goes on. */
  | { type: "budget"; reason: "tool_calls" | "tokens" }
  /** Step 84 (Xenacore): the answer follows a skill of the company or the user. */
  | { type: "skill"; name: string }
  /** Step 91 (Xenacore): facts the assistant kept in this answer; the panel offers to undo them. */
  | { type: "memory"; items: { id: string; text: string }[] }
  /** Step 101: what the answer really did, from its tool calls (not from the model's words). */
  | ({ type: "actions" } & ActionReport);

/** Step 101: one tool call of an answer. */
export interface ActionStep {
  tool: string;
  /** "unknown": the model called a tool that does not exist or that it may not use. */
  kind: "read" | "write-safe" | "write-confirm" | "send" | "unknown";
  status: "ok" | "error" | "proposed";
  /** Read tools only: their short arguments (search words, folder, dates). */
  args?: Record<string, unknown>;
  /** How many objects the call found or touched. */
  count?: number;
  proposalId?: string;
  /** A chat opened later: how the user answered the proposal. */
  outcome?: "pending" | "done" | "failed" | "rejected" | "expired";
  /** Step 120: the helper that made this call. */
  agent?: string;
}

/** Step 101: the report under an answer. */
export interface ActionReport {
  steps: ActionStep[];
  /** A tool changed something (proposals wait for the user: not yet). */
  changed: boolean;
  /** The answer says something was done although nothing was changed or proposed. */
  claimMismatch: boolean;
}

/** A message of a chat from the history (step 101: answers carry their report). */
export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  files?: AttachedFile[];
  actions?: ActionReport;
}

/** Step 83: one step of the assistant's plan. */
export interface PlanItem {
  text: string;
  status: "todo" | "doing" | "done";
}

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
  /** Step 84: where the person is; the assistant opens that topic of tools first. */
  page?: UiPage;
  /** Step 89: emails selected in the list (two or more). */
  selectedEmailIds?: string[];
  /** Step 89: what is open besides an email (ids only). */
  open?: ScreenOpen;
  /** Step 89: the calendar's view or Rooms' view (mentions, threads …). */
  view?: string;
  /** Step 89: the day the calendar shows (YYYY-MM-DD). */
  day?: string;
  /** Step 89: the folder open in Files. */
  folder?: string;
  /** Step 89: a settings or administration page (path after the language). */
  path?: string;
}

/** Step 89: something open on the screen, as the platform knows it. */
export interface ScreenOpen {
  kind: "event" | "task" | "file" | "room" | "thread" | "contact";
  id: string;
  room?: string;
  day?: string;
  /** An event's local start time (HH:MM). */
  time?: string;
}

export type UiPage = "mail" | "calendar" | "files" | "rooms" | "tasks" | "contacts" | "settings" | "workspace";

/** Step 84: the page of the app a path (without locale) belongs to; step 89 adds contacts, settings and administration. */
export function pageOf(pathname: string): UiPage | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  if (path === "/" || under("/mail")) return "mail";
  if (under("/calendar/tasks")) return "tasks";
  if (under("/calendar")) return "calendar";
  if (under("/files")) return "files";
  if (under("/chat")) return "rooms";
  if (under("/contacts")) return "contacts";
  if (under("/settings")) return "settings";
  if (under("/workspace")) return "workspace";
  return undefined;
}

export const assistant = {
  async status(): Promise<{ configured: boolean; enabled: boolean; usage?: { warning: boolean; blocked: boolean }; unread?: number; waiting?: number }> {
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
  /** Step 85: what connected AI chats wait for. */
  async waiting(): Promise<WaitingAction[]> {
    const res = await apiFetch("/api/ai/actions/waiting", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as { actions: WaitingAction[] }).actions : [];
  },
  async conversations(): Promise<ConversationInfo[]> {
    const res = await apiFetch("/api/ai/conversations", { credentials: "same-origin" });
    return res.ok ? (await res.json()).conversations : [];
  },
  async messages(id: string): Promise<StoredMessage[]> {
    return (await this.conversation(id)).messages;
  },
  /** Step 49: the messages and the proposals still waiting in the chat; opening it marks it read. */
  async conversation(id: string): Promise<{ messages: StoredMessage[]; proposals: WaitingProposal[] }> {
    const res = await apiFetch(`/api/ai/conversations/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!res.ok) return { messages: [], proposals: [] };
    const data = (await res.json()) as { messages?: StoredMessage[]; proposals?: WaitingProposal[] };
    return { messages: data.messages ?? [], proposals: data.proposals ?? [] };
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
  clearCachedPositions();
  try {
    sessionStorage.removeItem(ASSISTANT_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing stored.
  }
}
