"use client";

// The AI assistant side panel (spec I1–I3): a chat that knows the open email,
// streams answers, cites emails as clickable sources, and offers "Kurz" and
// "Mit KI antworten" for the open conversation. Shown only when the platform
// has the assistant configured and enabled for the user.
import { Fragment, type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { CalendarDays, Check, FileText, MessageSquare, PenLine, Plus, Send, Sparkles, Square, Trash2, X } from "@/components/icons";
import { useEmailStore } from "@/stores/email-store";
import { cn } from "@/lib/utils";
import { errorKey, XenaxioApiError } from "@/lib/xenaxio/api";
import {
  assistant,
  assistantAvailable,
  ASSISTANT_COMMAND_EVENT,
  ASSISTANT_STORAGE_KEY,
  type AssistantCommand,
  type AssistantEvent,
  assistantIds,
  messageRouteId,
  OPEN_DRAFT_EVENT,
  type ProposalSummary,
  type SourceEmail,
} from "@/lib/xenaxio/assistant";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";

type ProposalState = "pending" | "running" | "done" | "done_invited" | "invite_failed" | "rejected" | "expired" | "already" | "failed";

interface Proposal {
  id: string;
  tool: string;
  summary: ProposalSummary;
  state: ProposalState;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  sources?: SourceEmail[];
  proposals?: Proposal[];
  tool?: string;
  /** A tool call failed; worth showing only if no answer came after it. */
  toolFailed?: boolean;
  error?: string;
  title?: string;
}

const SURFACES = /\/(mail|calendar|contacts)(\/|$)|^\/$/;
/** Per-tab only; cleared with the tab and on sign-out. Holds the visible chat, nothing else. */
const STORAGE_KEY = ASSISTANT_STORAGE_KEY;

/** "Di., 27.10.2026, 10:00–10:30" from the local times the platform sends; all-day events as dates. */
function formatSpan(span: { start?: string; end?: string }, locale: string): string {
  if (!span.start) return "";
  // The times are wall-clock times in the summary's time zone; show them as they are.
  const dateOnly = span.start.length === 10;
  const asUtc = (local: string) => new Date(local.length === 10 ? `${local}T00:00:00Z` : `${local}:00Z`);
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  if (dateOnly) return span.end && span.end !== span.start ? `${day.format(asUtc(span.start))}–${day.format(asUtc(span.end))}` : day.format(asUtc(span.start));
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const end = span.end ? `–${time.format(asUtc(span.end))}` : "";
  return `${day.format(asUtc(span.start))}, ${time.format(asUtc(span.start))}${end}`;
}

/** Texts that differ for a change of a meeting (step 34); the rest is shared with new events. */
const UPDATE_KEYS = new Set(["event", "attendees", "invites_note", "running", "done", "done_invited", "invite_failed", "failed"]);

function ProposalCard({ proposal, locale, onDecide }: { proposal: Proposal; locale: string; onDecide: (p: Proposal, confirm: boolean) => void }) {
  const t = useXT();
  const s = proposal.summary;
  const update = proposal.tool === "update_event";
  const label = (key: string) => t(update && UPDATE_KEYS.has(key) ? `assistant.proposal_update.${key}` : `assistant.proposal.${key}`);
  const changed = (what: string) => update && !!s.changes?.includes(what);
  const was = (text?: string) => (text ? <span className="block text-muted-foreground line-through">{text}</span> : null);
  const attendees = s.attendees ?? [];
  const added = s.addedAttendees ?? [];
  const files = s.files ?? [];
  const settled = proposal.state !== "pending" && proposal.state !== "running";
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sm">
        <CalendarDays className="h-4 w-4 text-primary" />
        {label("event")}
      </p>
      <p className="font-medium text-sm">
        {s.title}
        {changed("title") && was(s.before?.title)}
      </p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">{label("when")}</dt>
        <dd>
          {formatSpan(s, locale)}
          {s.timeZone ? <span className="text-muted-foreground"> ({s.timeZone})</span> : null}
          {changed("time") && s.before && was(formatSpan(s.before, locale))}
        </dd>
        {s.location || changed("location") ? (
          <>
            <dt className="text-muted-foreground">{label("where")}</dt>
            <dd className="break-words">
              {s.location}
              {changed("location") && was(s.before?.location)}
            </dd>
          </>
        ) : null}
        {attendees.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{label("attendees")}</dt>
            <dd className="break-words">{attendees.join(", ")}</dd>
          </>
        ) : null}
        {added.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{t("assistant.proposal_update.added")}</dt>
            <dd className="break-words">{added.join(", ")}</dd>
          </>
        ) : null}
        {files.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{label("files")}</dt>
            <dd className="break-words">{files.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {attendees.length > 0 && proposal.state === "pending" && <p className="text-muted-foreground">{label("invites_note")}</p>}
      {settled ? (
        <p className={cn(["done", "done_invited"].includes(proposal.state) ? "text-primary" : "text-muted-foreground", "flex items-center gap-1")}>
          {["done", "done_invited"].includes(proposal.state) && <Check className="h-3.5 w-3.5" />}
          {label(proposal.state)}
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, true)}>
            {proposal.state === "running" ? label("running") : label("confirm")}
          </Button>
          <Button size="sm" variant="outline" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, false)}>
            {label("reject")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Minimal, safe rendering: paragraphs, "- " lists, **bold**, and [[mail:ID]] citations. */
function Formatted({ text, sources, onOpen }: { text: string; sources: SourceEmail[]; onOpen: (s: SourceEmail | string) => void }) {
  const inline = (line: string, key: string): ReactNode[] =>
    line.split(/(\[\[mail:[^\]\s]+\]\]|\*\*[^*]+\*\*)/g).map((part, i) => {
      const cite = /^\[\[mail:([^\]\s]+)\]\]$/.exec(part);
      if (cite) {
        const id = cite[1] as string;
        const n = sources.findIndex((s) => s.id === id);
        return (
          <button
            key={`${key}-${i}`}
            type="button"
            onClick={() => onOpen(sources[n] ?? id)}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/15 px-1 align-text-top text-[10px] font-semibold text-primary hover:bg-primary/25"
            title={sources[n]?.subject}
          >
            {n >= 0 ? n + 1 : "↗"}
          </button>
        );
      }
      const bold = /^\*\*([^*]+)\*\*$/.exec(part);
      if (bold) return <strong key={`${key}-${i}`}>{bold[1]}</strong>;
      return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
    });

  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => {
    if (list.length) blocks.push(<ul key={`ul${k}`} className="list-disc pl-5 space-y-1">{list.map((l, i) => <li key={i}>{inline(l, `li${k}-${i}`)}</li>)}</ul>);
    list = [];
  };
  text.split("\n").forEach((line, k) => {
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) list.push(item[1] as string);
    else {
      flush(k);
      if (line.trim()) blocks.push(<p key={`p${k}`}>{inline(line, `p${k}`)}</p>);
    }
  });
  flush(-1);
  return <div className="space-y-2 break-words">{blocks}</div>;
}

export function AssistantPanel() {
  const t = useXT();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const selectedEmail = useEmailStore((s) => s.selectedEmail);
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; title: string }[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  // Keep the panel and the current chat across page changes (e.g. opening a source).
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as { open?: boolean; turns?: Turn[]; conversationId?: string } | null;
      if (saved) {
        setOpen(!!saved.open);
        setTurns(saved.turns ?? []);
        setConversationId(saved.conversationId);
      }
    } catch {
      // Storage unavailable: start fresh.
    }
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current || busy) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, turns: turns.slice(-30), conversationId }));
    } catch {
      // Storage full or blocked: nothing to keep.
    }
  }, [open, turns, conversationId, busy]);

  useEffect(() => {
    if (!XENAXIO_BFF) return;
    void assistantAvailable().then(setAvailable);
  }, []);

  // I8: tell the user when most of this month's AI allowance is used.
  useEffect(() => {
    if (!open || !available) return;
    void assistant.status().then((s) => {
      if (s.usage?.warning) setNotice(t(s.usage.blocked ? "assistant.errors.ai_limit_reached" : "assistant.limit_warning"));
    }, () => undefined);
  }, [open, available, t]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const openSource = useCallback(
    (s: SourceEmail | string) => {
      const id = typeof s === "string" ? s : s.id;
      router.push(`/mail/message/${encodeURIComponent(messageRouteId(id))}`);
    },
    [router],
  );

  /** Runs one streamed request and fills the last assistant turn. */
  const run = useCallback(
    async (events: (signal: AbortSignal) => AsyncIterable<AssistantEvent>, userText: string | null, title?: string) => {
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setNotice(null);
      setTurns((prev) => [...prev, ...(userText ? [{ role: "user" as const, text: userText }] : []), { role: "assistant", text: "", ...(title ? { title } : {}) }]);
      const update = (fn: (turn: Turn) => Turn) => setTurns((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1] as Turn)]);
      try {
        for await (const e of events(controller.signal)) {
          if (e.type === "start" && e.conversationId) setConversationId(e.conversationId);
          else if (e.type === "text") update((turn) => ({ ...turn, text: turn.text + e.text, tool: undefined }));
          else if (e.type === "tool") update((turn) => ({ ...turn, tool: e.status === "start" ? e.name : undefined, ...(e.status === "error" ? { toolFailed: true } : {}) }));
          else if (e.type === "sources") update((turn) => ({ ...turn, sources: e.emails }));
          else if (e.type === "proposal") update((turn) => ({ ...turn, proposals: [...(turn.proposals ?? []), { id: e.id, tool: e.tool, summary: e.summary, state: "pending" }] }));
          else if (e.type === "error") update((turn) => ({ ...turn, error: t(`assistant.errors.${e.code}`) }));
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          const key = errorKey(err);
          const code = key.replace("errors.", "");
          update((turn) => ({ ...turn, error: ["ai_disabled", "ai_not_configured", "ai_limit_reached", "rate_limited"].includes(code) ? t(`assistant.errors.${code}`) : t(key) }));
        }
      } finally {
        setBusy(false);
        abort.current = null;
      }
    },
    [t],
  );

  /** I5: the user confirms or discards a proposal; the platform runs it exactly as shown. */
  const decide = useCallback(async (proposal: Proposal, confirm: boolean) => {
    const set = (state: ProposalState) =>
      setTurns((prev) => prev.map((turn) => (turn.proposals?.some((p) => p.id === proposal.id) ? { ...turn, proposals: turn.proposals.map((p) => (p.id === proposal.id ? { ...p, state } : p)) } : turn)));
    set("running");
    try {
      if (!confirm) {
        await assistant.reject(proposal.id);
        set("rejected");
        return;
      }
      const { result } = await assistant.confirm(proposal.id);
      set(result.invited?.length ? (result.invitationSent ? "done_invited" : "invite_failed") : "done");
    } catch (err) {
      const status = err instanceof XenaxioApiError ? err.status : 0;
      set(status === 410 ? "expired" : status === 409 ? "already" : status === 0 ? "pending" : "failed");
      if (status === 0) setNotice(t("errors.network"));
    }
  }, [t]);

  // Step 31: mail of a shared mailbox is named with its account.
  const context = selectedEmail ? assistantIds(selectedEmail) : {};

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void run((signal) => assistant.chat(text, conversationId, context, signal), text);
  };

  const summarize = useCallback(
    (threadId: string, subject: string) => {
      setOpen(true);
      void run((signal) => assistant.summarize(threadId, signal), null, t("assistant.summary_title", { subject }));
    },
    [run, t],
  );

  const draftReply = async () => {
    if (!selectedEmail) return;
    setBusy(true);
    setNotice(t("assistant.reply_creating"));
    try {
      const { draftId } = await assistant.reply(assistantIds(selectedEmail).emailId, input.trim());
      setInput("");
      setNotice(t("assistant.reply_done"));
      window.dispatchEvent(new CustomEvent(OPEN_DRAFT_EVENT, { detail: { draftId } }));
    } catch (err) {
      setNotice(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const draftReplyRef = useRef(draftReply);
  draftReplyRef.current = draftReply;

  // Commands from elsewhere in the app (e.g. the "Kurz" button on an email).
  useEffect(() => {
    const onCommand = (ev: Event) => {
      const cmd = (ev as CustomEvent<AssistantCommand>).detail;
      if (cmd.action === "open") setOpen(true);
      if (cmd.action === "summarize") summarize(cmd.threadId, cmd.subject ?? "");
      if (cmd.action === "reply") {
        setOpen(true);
        void draftReplyRef.current();
      }
    };
    window.addEventListener(ASSISTANT_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(ASSISTANT_COMMAND_EVENT, onCommand);
  }, [summarize]);

  const newChat = () => {
    abort.current?.abort();
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setTurns([]);
    setConversationId(undefined);
    setHistory(null);
    setNotice(null);
  };

  const showHistory = async () => setHistory(await assistant.conversations());
  const loadConversation = async (id: string) => {
    const msgs = await assistant.messages(id);
    setTurns(msgs.map((m) => ({ role: m.role, text: m.content })));
    setConversationId(id);
    setHistory(null);
  };

  if (!available || !SURFACES.test(pathname)) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 md:bottom-6 md:right-6"
        aria-label={t("assistant.open")}
        title={t("assistant.open")}
      >
        <Sparkles className="h-5 w-5" />
      </button>
    );
  }

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background text-foreground shadow-xl sm:w-[400px]"
      aria-label={t("assistant.title")}
    >
      <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex items-center gap-2 font-medium">
          <Sparkles className="h-4 w-4 text-primary" />
          {t("assistant.title")}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={showHistory} title={t("assistant.history")} aria-label={t("assistant.history")}>
            <MessageSquare className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={newChat} title={t("assistant.new_chat")} aria-label={t("assistant.new_chat")}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} title={t("assistant.close")} aria-label={t("assistant.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {selectedEmail && (
        <div className="border-b border-border px-3 py-2 space-y-2">
          <p className="truncate text-xs text-muted-foreground">{t("assistant.context", { subject: selectedEmail.subject || "—" })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => summarize(selectedEmail.threadId, selectedEmail.subject ?? "")}>
              <FileText className="mr-1.5 h-4 w-4" />
              {t("assistant.summarize")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={draftReply}>
              <PenLine className="mr-1.5 h-4 w-4" />
              {t("assistant.reply")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 text-sm space-y-4">
        {history ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t("assistant.history")}</p>
            {history.map((c) => (
              <div key={c.id} className="flex items-center gap-1">
                <button type="button" className="flex-1 truncate rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => loadConversation(c.id)}>
                  {c.title || "—"}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("assistant.delete")}
                  onClick={async () => {
                    await assistant.remove(c.id);
                    setHistory((h) => h?.filter((x) => x.id !== c.id) ?? null);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={async () => {
                  await assistant.remove();
                  setHistory([]);
                  newChat();
                }}
              >
                {t("assistant.delete_all")}
              </Button>
            )}
          </div>
        ) : turns.length === 0 ? (
          <div className="space-y-2 text-muted-foreground">
            <p>{t("assistant.empty")}</p>
            <p className="text-xs">{t("assistant.not_sent")}</p>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div key={i} className={cn("space-y-2", turn.role === "user" && "ml-8 rounded-lg bg-primary/10 px-3 py-2")}>
              {turn.title && <p className="text-xs font-medium text-muted-foreground">{turn.title}</p>}
              {turn.role === "user" ? <p className="whitespace-pre-wrap">{turn.text}</p> : <Formatted text={turn.text} sources={turn.sources ?? []} onOpen={openSource} />}
              {turn.tool && <p className="animate-pulse text-xs text-muted-foreground">{t(`assistant.tool_${turn.tool}`)}</p>}
              {turn.role === "assistant" && !turn.text && !turn.tool && busy && i === turns.length - 1 && <p className="animate-pulse text-xs text-muted-foreground">…</p>}
              {turn.error && <p className="text-xs text-destructive">{turn.error}</p>}
              {/* The model usually recovers from a failed step; warn only when no answer came. */}
              {turn.toolFailed && !turn.error && !turn.text.trim() && !(busy && i === turns.length - 1) && <p className="text-xs text-destructive">{t("assistant.tool_error")}</p>}
              {turn.proposals?.map((p) => <ProposalCard key={p.id} proposal={p} locale={locale} onDecide={decide} />)}
              {turn.sources && turn.sources.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("assistant.sources")}</p>
                  {turn.sources.map((s, n) => (
                    <button key={s.id} type="button" onClick={() => openSource(s)} className="flex w-full items-start gap-2 rounded border border-border px-2 py-1.5 text-left text-xs hover:bg-muted">
                      <span className="font-semibold text-primary">{n + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.subject || "—"}</span>
                        <span className="block truncate text-muted-foreground">
                          {(s.from[0] ?? "").replace(/<.*>/, "").trim()}
                          {s.receivedAt ? ` · ${new Date(s.receivedAt).toLocaleDateString()}` : ""}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {notice && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
      <form onSubmit={send} className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={selectedEmail ? `${t("assistant.placeholder")} · ${t("assistant.reply_instructions")}` : t("assistant.placeholder")}
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("assistant.placeholder")}
        />
        {busy && abort.current ? (
          <Button type="button" variant="outline" onClick={() => abort.current?.abort()} aria-label={t("assistant.stop")}>
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim() || busy} aria-label={t("assistant.send")}>
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>
    </aside>
  );
}
