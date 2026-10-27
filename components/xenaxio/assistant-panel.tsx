"use client";

// The AI assistant side panel (spec I1–I3): a chat that knows the open email,
// streams answers, cites emails as clickable sources, and offers "Kurz" and
// "Mit KI antworten" for the open conversation. Shown only when the platform
// has the assistant configured and enabled for the user. Step 33: files and
// pictures go into the chat (paperclip, paste, drop) and are kept in Files.
import { type ClipboardEvent, type DragEvent, Fragment, type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Brain, CalendarDays, Check, File as FileIcon, FileText, FolderOpen, Image as ImageIcon, Loader2, MessageSquare, Paperclip, PenLine, Plus, Send, Sparkles, Square, Trash2, Upload, X } from "@/components/icons";
import { FilePickerDialog } from "@/components/files/file-picker-dialog";
import type { FileNode } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { cn, formatFileSize } from "@/lib/utils";
import { errorKey, XenaxioApiError } from "@/lib/xenaxio/api";
import {
  assistant,
  assistantAvailable,
  ASSISTANT_COMMAND_EVENT,
  ASSISTANT_STORAGE_KEY,
  type AssistantCommand,
  type AssistantEvent,
  assistantIds,
  type AttachedFile,
  attachedFileLink,
  chatFileProblem,
  isChatImage,
  MAX_CHAT_FILES,
  messageRouteId,
  pastedName,
  OPEN_DRAFT_EVENT,
  type ProposalSummary,
  type SourceEmail,
} from "@/lib/xenaxio/assistant";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { TaskCard } from "@/components/xenaxio/task-card";

type ProposalState = "pending" | "running" | "done" | "done_invited" | "invite_failed" | "rejected" | "expired" | "already" | "failed" | "memory_full" | "memory_off";

interface Proposal {
  id: string;
  tool: string;
  summary: ProposalSummary;
  state: ProposalState;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Files the user attached (step 33). */
  files?: AttachedFile[];
  sources?: SourceEmail[];
  proposals?: Proposal[];
  tool?: string;
  /** A tool call failed; worth showing only if no answer came after it. */
  toolFailed?: boolean;
  error?: string;
  /** Step 45: a note about the answer (it came from the fallback model). */
  notice?: string;
  title?: string;
}

/** A file waiting under the input: uploading, ready to send, or refused. */
interface PendingFile {
  key: string;
  name: string;
  size: number;
  type: string;
  file?: AttachedFile;
  /** Message key of why it cannot be sent. */
  error?: string;
  /** Local preview of a picture (object URL). */
  preview?: string;
}

/** A file as a small card: picture or file icon, name and size; linked to Files when possible. */
function FileChip({ name, size, type, preview, href, deleted, busy, error, onOpen, onRemove, removeLabel, deletedLabel }: {
  name: string;
  size: number;
  type: string;
  preview?: string;
  href?: string | null;
  deleted?: boolean;
  busy?: boolean;
  error?: string;
  onOpen?: (href: string) => void;
  onRemove?: () => void;
  removeLabel?: string;
  deletedLabel?: string;
}) {
  const body = (
    <>
      {preview ? (
        <img src={preview} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
      ) : isChatImage(type) ? (
        <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate font-medium", deleted && "line-through text-muted-foreground")}>{name}</span>
        <span className={cn("block truncate", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? (deleted ? deletedLabel : formatFileSize(size))}
        </span>
      </span>
      {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
    </>
  );
  return (
    <div className={cn("flex items-center gap-2 rounded border px-2 py-1 text-xs", error ? "border-destructive/50" : "border-border", "bg-background")}>
      {href && onOpen ? (
        <button type="button" onClick={() => onOpen(href)} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={removeLabel} title={removeLabel}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// Step 43, part D: also the team chat (not its admin page under /workspace).
const SURFACES = /\/(mail|calendar|contacts)(\/|$)|^\/$|^\/chat(\/|$)/;
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

/** Step 36: remember or forget a note; saved only when the user confirms it here. */
function MemoryCard({ proposal, onDecide }: { proposal: Proposal; onDecide: (p: Proposal, confirm: boolean) => void }) {
  const t = useXT();
  const forget = proposal.tool === "forget";
  const label = (key: string) => t(`assistant.memory.${forget ? "forget" : "remember"}.${key}`);
  const shared = (key: string) => t(`assistant.memory.${key}`);
  const settled = proposal.state !== "pending" && proposal.state !== "running";
  const done = proposal.state === "done";
  const stateText = done ? label("done") : ["memory_full", "memory_off", "failed"].includes(proposal.state) ? shared(proposal.state) : t(`assistant.proposal.${proposal.state}`);
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sm">
        <Brain className="h-4 w-4 text-primary" />
        {label(proposal.summary.replaces ? "title_replace" : "title")}
      </p>
      <p className={cn("border-l-2 border-primary/40 pl-2 text-sm break-words", forget && "line-through")}>{proposal.summary.text}</p>
      {proposal.summary.replaces && <p className="border-l-2 border-border pl-2 break-words text-muted-foreground line-through">{proposal.summary.replaces}</p>}
      {proposal.state === "pending" && <p className="text-muted-foreground">{label("note")}</p>}
      {settled ? (
        <p className={cn(done ? "text-primary" : "text-muted-foreground", "flex items-center gap-1")}>
          {done && <Check className="h-3.5 w-3.5" />}
          {stateText}
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, true)}>
            {proposal.state === "running" ? shared("running") : t("assistant.proposal.confirm")}
          </Button>
          <Button size="sm" variant="outline" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, false)}>
            {t("assistant.proposal.reject")}
          </Button>
        </div>
      )}
      <Link href="/workspace/assistant" className="inline-block text-muted-foreground underline hover:text-foreground">
        {shared("all_notes")}
      </Link>
    </div>
  );
}

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
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [attachMenu, setAttachMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const filesClient = useAuthStore((s) => s.client);
  const canPickFiles = !!filesClient?.supportsFiles();

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
    async (events: (signal: AbortSignal) => AsyncIterable<AssistantEvent>, userText: string | null, title?: string, files?: AttachedFile[]) => {
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setNotice(null);
      const user: Turn[] = userText !== null ? [{ role: "user", text: userText, ...(files?.length ? { files } : {}) }] : [];
      setTurns((prev) => [...prev, ...user, { role: "assistant", text: "", ...(title ? { title } : {}) }]);
      const update = (fn: (turn: Turn) => Turn) => setTurns((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1] as Turn)]);
      try {
        for await (const e of events(controller.signal)) {
          if (e.type === "start" && e.conversationId) setConversationId(e.conversationId);
          else if (e.type === "text") update((turn) => ({ ...turn, text: turn.text + e.text, tool: undefined }));
          else if (e.type === "tool") update((turn) => ({ ...turn, tool: e.status === "start" ? e.name : undefined, ...(e.status === "error" ? { toolFailed: true } : {}) }));
          else if (e.type === "sources") update((turn) => ({ ...turn, sources: e.emails }));
          else if (e.type === "proposal") update((turn) => ({ ...turn, proposals: [...(turn.proposals ?? []), { id: e.id, tool: e.tool, summary: e.summary, state: "pending" }] }));
          else if (e.type === "error") update((turn) => ({ ...turn, error: t(`assistant.errors.${e.code}`) }));
          else if (e.type === "notice") update((turn) => ({ ...turn, notice: t(`assistant.notice_${e.code}`) }));
        }
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          const key = errorKey(err);
          const code = key.replace("errors.", "");
          update((turn) => ({ ...turn, error: ["ai_disabled", "ai_not_configured", "ai_limit_reached", "rate_limited", "file_not_found", "custom_model_unavailable"].includes(code) ? t(`assistant.errors.${code}`) : t(key) }));
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
      // Step 36: the memory is full or was switched off after the proposal.
      const code = err instanceof XenaxioApiError ? err.code : "";
      if (code === "memory_full" || code === "memory_off") return set(code);
      set(status === 410 ? "expired" : status === 409 ? "already" : status === 0 ? "pending" : "failed");
      if (status === 0) setNotice(t("errors.network"));
    }
  }, [t]);

  // Step 31: mail of a shared mailbox is named with its account.
  const context = selectedEmail ? assistantIds(selectedEmail) : {};

  // Step 33: files wait under the input until the message is sent.
  const ready = pending.filter((p) => p.file).map((p) => p.file as AttachedFile);
  const uploading = pending.some((p) => !p.file && !p.error);
  const canSend = (!!input.trim() || ready.length > 0) && !busy && !uploading;

  const dropPending = (key: string) =>
    setPending((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((p) => p.key !== key);
    });

  const addFiles = (list: File[]) => {
    setNotice(null);
    const room = MAX_CHAT_FILES - pending.length;
    if (list.length > room) setNotice(t("assistant.attach_limit", { max: String(MAX_CHAT_FILES) }));
    for (const f of list.slice(0, Math.max(room, 0))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const problem = chatFileProblem(f);
      const preview = !problem && isChatImage(f.type) ? URL.createObjectURL(f) : undefined;
      setPending((prev) => [...prev, { key, name: f.name, size: f.size, type: f.type, ...(problem ? { error: problem } : {}), ...(preview ? { preview } : {}) }]);
      if (problem) continue;
      assistant.upload(f, f.name).then(
        (file) => setPending((prev) => prev.map((p) => (p.key === key ? { ...p, file, name: file.name } : p))),
        (err: unknown) => {
          const code = err instanceof XenaxioApiError ? err.code : "";
          const error = code === "file_too_large" ? "attach_too_large" : code === "storage_full" ? "attach_storage_full" : "attach_failed";
          setPending((prev) => prev.map((p) => (p.key === key ? { ...p, error } : p)));
        },
      );
    }
  };

  const addPicked = (nodes: FileNode[]) => {
    setPicking(false);
    const room = MAX_CHAT_FILES - pending.length;
    if (nodes.length > room) setNotice(t("assistant.attach_limit", { max: String(MAX_CHAT_FILES) }));
    const picked = nodes.slice(0, Math.max(room, 0)).map((n): PendingFile => {
      const file = { id: n.id, name: n.name, type: n.type || "application/octet-stream", size: n.size ?? 0 };
      const problem = chatFileProblem(file);
      return { key: `pick-${n.id}`, ...file, ...(problem ? { error: problem } : { file }) };
    });
    setPending((prev) => [...prev, ...picked.filter((p) => !prev.some((q) => q.key === p.key))]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length === 0) return;
    e.preventDefault();
    // Screenshots come as "image.png"; name them by date so they can be found in Files.
    addFiles(pasted.map((f) => (f.type.startsWith("image/") ? new File([f], pastedName(t("assistant.pasted_image"), f.type), { type: f.type }) : f)));
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!canSend) return;
    const files = ready;
    setInput("");
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    setPending([]);
    void run((signal) => assistant.chat(text, conversationId, context, signal, files.map((f) => f.id)), text, undefined, files);
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

  // Step 43, part D: a question from elsewhere (the chat's "Zusammenfassen").
  const ask = (text: string) => {
    setOpen(true);
    void run((signal) => assistant.chat(text, conversationId, context, signal, []), text);
  };
  const askRef = useRef(ask);
  askRef.current = ask;

  // Commands from elsewhere in the app (e.g. the "Kurz" button on an email).
  useEffect(() => {
    const onCommand = (ev: Event) => {
      const cmd = (ev as CustomEvent<AssistantCommand>).detail;
      if (cmd.action === "open") setOpen(true);
      if (cmd.action === "summarize") summarize(cmd.threadId, cmd.subject ?? "");
      if (cmd.action === "ask" && cmd.text.trim()) askRef.current(cmd.text.trim());
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
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    setPending([]);
  };

  const showHistory = async () => setHistory(await assistant.conversations());
  const loadConversation = async (id: string) => {
    const msgs = await assistant.messages(id);
    setTurns(msgs.map((m) => ({ role: m.role, text: m.content, ...(m.files?.length ? { files: m.files } : {}) })));
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
      data-xenaxio-glass=""
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background text-foreground shadow-xl sm:w-[400px]"
      aria-label={t("assistant.title")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary">
          <Upload className="mr-2 h-5 w-5" />
          {t("assistant.attach_drop")}
        </div>
      )}
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
              {turn.files?.map((f) => (
                <FileChip key={f.id} name={f.name} size={f.size} type={f.type} href={attachedFileLink(f)} deleted={f.deleted} deletedLabel={t("assistant.file_deleted")} onOpen={(href) => router.push(href)} />
              ))}
              {turn.role === "user" ? turn.text && <p className="whitespace-pre-wrap">{turn.text}</p> : <Formatted text={turn.text} sources={turn.sources ?? []} onOpen={openSource} />}
              {turn.tool && <p className="animate-pulse text-xs text-muted-foreground">{t(`assistant.tool_${turn.tool}`)}</p>}
              {turn.role === "assistant" && !turn.text && !turn.tool && busy && i === turns.length - 1 && <p className="animate-pulse text-xs text-muted-foreground">…</p>}
              {turn.notice && <p className="text-xs text-amber-700 dark:text-amber-400">{turn.notice}</p>}
              {turn.error && <p className="text-xs text-destructive">{turn.error}</p>}
              {/* The model usually recovers from a failed step; warn only when no answer came. */}
              {turn.toolFailed && !turn.error && !turn.text.trim() && !(busy && i === turns.length - 1) && <p className="text-xs text-destructive">{t("assistant.tool_error")}</p>}
              {turn.proposals?.map((p) =>
                p.tool === "remember" || p.tool === "forget" ? (
                  <MemoryCard key={p.id} proposal={p} onDecide={decide} />
                ) : p.tool === "create_task" || p.tool === "update_task" ? (
                  <TaskCard key={p.id} proposal={p} locale={locale} onDecide={(_task, confirm) => decide(p, confirm)} />
                ) : (
                  <ProposalCard key={p.id} proposal={p} locale={locale} onDecide={decide} />
                ),
              )}
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
      {pending.length > 0 && (
        <div className="space-y-1 border-t border-border px-3 pt-2">
          {pending.map((p) => (
            <FileChip
              key={p.key}
              name={p.name}
              size={p.size}
              type={p.type}
              {...(p.preview ? { preview: p.preview } : {})}
              busy={!p.file && !p.error}
              {...(p.error ? { error: t(`assistant.${p.error}`) } : {})}
              onRemove={() => dropPending(p.key)}
              removeLabel={t("assistant.attach_remove")}
            />
          ))}
          <p className="text-[11px] text-muted-foreground">{uploading ? t("assistant.attach_uploading") : t("assistant.attach_saved")}</p>
        </div>
      )}
      <form onSubmit={send} className="relative flex items-end gap-2 border-t border-border p-3">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {attachMenu && (
          <div className="absolute bottom-full left-3 z-10 mb-1 w-56 rounded-md border border-border bg-background p-1 text-sm shadow-lg" role="menu">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setAttachMenu(false);
                fileInput.current?.click();
              }}
            >
              <Upload className="h-4 w-4" />
              {t("assistant.attach_device")}
            </button>
            {canPickFiles && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setAttachMenu(false);
                  setPicking(true);
                }}
              >
                <FolderOpen className="h-4 w-4" />
                {t("assistant.attach_files")}
              </button>
            )}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 px-2"
          disabled={busy || pending.length >= MAX_CHAT_FILES}
          onClick={() => setAttachMenu((v) => !v)}
          aria-label={t("assistant.attach")}
          title={t("assistant.attach")}
          aria-haspopup="menu"
          aria-expanded={attachMenu}
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          value={input}
          onPaste={onPaste}
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
          <Button type="submit" disabled={!canSend} aria-label={t("assistant.send")}>
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>
      {picking && filesClient && <FilePickerDialog client={filesClient} onClose={() => setPicking(false)} onPick={addPicked} />}
    </aside>
  );
}
