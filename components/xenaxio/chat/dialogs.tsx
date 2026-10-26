"use client";

// Step 43, part B: dialogs of the chat — confirm and prompt (shared with the
// whole chat through a context), choosing people, creating a channel, and the
// Ctrl+K switcher.
import { IconHash, IconLock, IconSearch, IconX } from "@tabler/icons-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { usePromptDialog } from "@/hooks/use-prompt-dialog";
import type { ChatClient } from "@/lib/xenaxio/chat/client";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { PersonAvatar, presenceOf } from "./common";

type Confirm = ReturnType<typeof useConfirmDialog>["confirm"];
type Prompt = ReturnType<typeof usePromptDialog>["prompt"];

const DialogsContext = createContext<{ confirm: Confirm; prompt: Prompt } | null>(null);

export function ChatDialogsProvider({ children }: { children: ReactNode }) {
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const { dialogProps: promptProps, prompt } = usePromptDialog();
  const value = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  return (
    <DialogsContext.Provider value={value}>
      {children}
      <ConfirmDialog {...confirmProps} />
      <PromptDialog {...promptProps} />
    </DialogsContext.Provider>
  );
}

export function useChatDialogs() {
  const value = useContext(DialogsContext);
  if (!value) throw new Error("useChatDialogs outside ChatDialogsProvider");
  return value;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = useXT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn("w-full rounded-lg border border-border bg-background shadow-xl", wide ? "max-w-xl" : "max-w-md")}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("chat.close")} className="rounded p-1 hover:bg-accent">
            <IconX size={18} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/** Choose colleagues (new direct message, adding people to a channel). */
export function PeoplePicker({
  title,
  action,
  client,
  max = 8,
  exclude = [],
  onDone,
  onClose,
}: {
  title: string;
  action: string;
  client: ChatClient;
  max?: number;
  exclude?: string[];
  onDone: (userIds: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useXT();
  const colleagues = useChatStore((s) => s.colleagues);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...colleagues.values()]
      .filter((c) => c.address !== client.userId && !exclude.includes(c.address) && !picked.includes(c.address))
      .filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      .slice(0, 50);
  }, [colleagues, query, picked, client.userId, exclude]);
  const submit = async () => {
    if (!picked.length) return;
    setBusy(true);
    try {
      await onDone(picked);
      onClose();
    } catch {
      toast.error(t("chat.error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-wrap gap-1 rounded-md border border-input px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
        {picked.map((u) => (
          <span key={u} className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-sm">
            {colleagues.get(u)?.displayName ?? u}
            <button type="button" onClick={() => setPicked(picked.filter((p) => p !== u))} aria-label={t("chat.close")}>
              <IconX size={12} />
            </button>
          </span>
        ))}
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.dm_search")} className="min-w-32 flex-1 bg-transparent text-sm focus:outline-none" />
      </div>
      {picked.length >= max && <p className="mt-1 text-xs text-muted-foreground">{t("chat.dm_limit")}</p>}
      <div className="mt-2 max-h-72 overflow-y-auto">
        {people.map((c) => (
          <button
            key={c.address}
            type="button"
            disabled={picked.length >= max}
            onClick={() => {
              setPicked([...picked, c.address]);
              setQuery("");
            }}
            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
          >
            <PersonAvatar userId={c.address} name={c.displayName} size="sm" presence={presenceOf(client, c.address)} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.displayName}</span>
              <span className="block truncate text-xs text-muted-foreground">{c.email}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" disabled={!picked.length || busy} onClick={() => void submit()} className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">
          {action}
        </button>
      </div>
    </Modal>
  );
}

export function CreateChannelDialog({ client, onClose, onCreated }: { client: ChatClient; onClose: () => void; onCreated: (roomId: string) => void }) {
  const t = useXT();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPublic, setPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  // Slack-style names: lower case, words joined by dashes.
  const clean = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9äöüß_-]/g, "").slice(0, 80);
  const submit = async () => {
    if (!clean) return;
    setBusy(true);
    try {
      onCreated(await client.createChannel({ name: clean, topic: topic.trim() || undefined, isPublic }));
      onClose();
    } catch {
      toast.error(t("chat.error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("chat.create_title")} onClose={onClose}>
      <label className="block text-sm font-medium">{t("chat.create_name")}</label>
      <div className="mt-1 flex items-center rounded-md border border-input px-2 focus-within:ring-2 focus-within:ring-ring">
        {isPublic ? <IconHash size={16} className="text-muted-foreground" /> : <IconLock size={16} className="text-muted-foreground" />}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("chat.create_name_hint")} className="h-9 flex-1 bg-transparent px-1 text-sm focus:outline-none" onKeyDown={(e) => e.key === "Enter" && void submit()} />
      </div>
      {name && clean !== name.trim() && <p className="mt-1 text-xs text-muted-foreground">#{clean}</p>}
      <label className="mt-3 block text-sm font-medium">{t("chat.create_topic")}</label>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
      <div className="mt-3 space-y-1.5 text-sm">
        <label className="flex items-start gap-2">
          <input type="radio" checked={isPublic} onChange={() => setPublic(true)} className="mt-1" />
          <span>{t("chat.create_public")}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" checked={!isPublic} onChange={() => setPublic(false)} className="mt-1" />
          <span>{t("chat.create_private")}</span>
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" disabled={!clean || busy} onClick={() => void submit()} className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">
          {t("chat.create")}
        </button>
      </div>
    </Modal>
  );
}

/** Ctrl+K: jump to a channel or person by typing. */
export function QuickSwitcher({ client, onClose, onOpenRoom, onOpenPerson }: { client: ChatClient; onClose: () => void; onOpenRoom: (roomId: string) => void; onOpenPerson: (userId: string) => void }) {
  const t = useXT();
  const colleagues = useChatStore((s) => s.colleagues);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@]/, "");
    const rooms = [...client.rooms.values()]
      .filter((r) => r.membership === "join" && r.kind !== "space")
      .map((r) => ({ key: r.id, kind: "room" as const, label: client.roomName(r), dm: r.kind === "dm", priv: r.joinRule !== "public", unread: r.notifications, last: r.lastTs }));
    const dmPartners = new Set([...client.rooms.values()].filter((r) => r.kind === "dm").flatMap((r) => client.dmPartners(r)));
    const people = [...colleagues.values()]
      .filter((c) => c.address !== client.userId && !dmPartners.has(c.address))
      .map((c) => ({ key: c.address, kind: "person" as const, label: c.displayName, dm: true, priv: false, unread: 0, last: 0 }));
    return [...rooms, ...people]
      .filter((i) => !q || i.label.toLowerCase().includes(q))
      .sort((a, b) => (q ? Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)) : 0) || b.unread - a.unread || b.last - a.last)
      .slice(0, 12);
  }, [query, client, colleagues]);
  useEffect(() => setSelected(0), [query]);
  const open = (i: (typeof items)[number]) => {
    onClose();
    if (i.kind === "room") onOpenRoom(i.key);
    else onOpenPerson(i.key);
  };
  return (
    <Modal title={t("chat.jump")} onClose={onClose}>
      <div className="flex items-center gap-2 rounded-md border border-input px-2 focus-within:ring-2 focus-within:ring-ring">
        <IconSearch size={16} className="text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chat.jump_hint")}
          className="h-10 flex-1 bg-transparent text-sm focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && items[selected]) {
              open(items[selected]);
            }
          }}
        />
      </div>
      <div ref={list} className="mt-2 max-h-80 overflow-y-auto" role="listbox">
        {items.map((i, idx) => (
          <button
            key={i.key}
            type="button"
            role="option"
            aria-selected={idx === selected}
            onMouseEnter={() => setSelected(idx)}
            onClick={() => open(i)}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", idx === selected && "bg-accent")}
          >
            {i.kind === "person" || i.dm ? (
              <PersonAvatar userId={i.kind === "person" ? i.key : client.dmPartners(client.rooms.get(i.key)!)[0] ?? i.key} name={i.label} size="sm" />
            ) : i.priv ? (
              <IconLock size={16} className="text-muted-foreground" />
            ) : (
              <IconHash size={16} className="text-muted-foreground" />
            )}
            <span className={cn("truncate", i.unread > 0 && "font-semibold")}>{i.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
