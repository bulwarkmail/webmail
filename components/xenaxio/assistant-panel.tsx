"use client";

// The AI assistant side panel (spec I1–I3): a chat that knows the open email,
// streams answers, cites emails as clickable sources, and offers "Kurz" and
// "Mit KI antworten" for the open conversation. Shown only when the platform
// has the assistant configured and enabled for the user.
import { Fragment, type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { FileText, MessageSquare, PenLine, Plus, Send, Sparkles, Square, Trash2, X } from "@/components/icons";
import { useEmailStore } from "@/stores/email-store";
import { cn } from "@/lib/utils";
import { errorKey } from "@/lib/xenaxio/api";
import {
  assistant,
  assistantAvailable,
  ASSISTANT_COMMAND_EVENT,
  ASSISTANT_STORAGE_KEY,
  type AssistantCommand,
  type AssistantEvent,
  OPEN_DRAFT_EVENT,
  type SourceEmail,
} from "@/lib/xenaxio/assistant";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";

interface Turn {
  role: "user" | "assistant";
  text: string;
  sources?: SourceEmail[];
  tool?: string;
  error?: string;
  title?: string;
}

const SURFACES = /\/(mail|calendar|contacts)(\/|$)|^\/$/;
/** Per-tab only; cleared with the tab and on sign-out. Holds the visible chat, nothing else. */
const STORAGE_KEY = ASSISTANT_STORAGE_KEY;

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const openSource = useCallback(
    (s: SourceEmail | string) => {
      const id = typeof s === "string" ? s : s.id;
      router.push(`/mail/message/${encodeURIComponent(id)}`);
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
          else if (e.type === "tool") update((turn) => ({ ...turn, tool: e.status === "start" ? e.name : undefined, ...(e.status === "error" ? { error: t("assistant.tool_error") } : {}) }));
          else if (e.type === "sources") update((turn) => ({ ...turn, sources: e.emails }));
          else if (e.type === "error") update((turn) => ({ ...turn, error: t(`assistant.errors.${e.code}`) }));
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          const key = errorKey(err);
          const code = key.replace("errors.", "");
          update((turn) => ({ ...turn, error: ["ai_disabled", "ai_not_configured", "rate_limited"].includes(code) ? t(`assistant.errors.${code}`) : t(key) }));
        }
      } finally {
        setBusy(false);
        abort.current = null;
      }
    },
    [t],
  );

  const context = selectedEmail ? { emailId: selectedEmail.id, threadId: selectedEmail.threadId } : {};

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
      const { draftId } = await assistant.reply(selectedEmail.id, input.trim());
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
