// Client for the xenaxio assistant (/api/ai): server-sent events over fetch,
// so the request can carry the session cookie, a JSON body and the CSRF header.
import { apiFetch } from "@/lib/browser-navigation";
import { XenaxioApiError } from "./api";

export interface SourceEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string[];
  receivedAt?: string;
}

/** What the assistant proposes to create (I5); runs only after "Bestätigen". */
export interface ProposalSummary {
  title?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string;
  attendees?: string[];
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
  | { type: "error"; code: string };

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
  async *chat(message: string, conversationId: string | undefined, context: ChatContext, signal?: AbortSignal) {
    yield* readEvents(await post("/api/ai/chat", { message, ...(conversationId ? { conversationId } : {}), context }, signal));
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
  async messages(id: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
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

/** Events between the assistant UI and the mail app (no shared imports needed). */
export const OPEN_DRAFT_EVENT = "xenaxio:open-draft";
export const ASSISTANT_COMMAND_EVENT = "xenaxio:assistant";

export type AssistantCommand =
  | { action: "open" }
  | { action: "summarize"; threadId: string; subject?: string }
  | { action: "reply" };

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
