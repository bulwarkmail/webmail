"use client";

// Step 43, part B: the chat's left column, as in Slack — company name, jump
// and search, Threads / Erwähnungen / Gespeichert, starred, channels, direct
// messages and invitations; unread in bold, mentions as a badge.
import { IconAt, IconBookmark, IconChevronDown, IconChevronRight, IconHash, IconLock, IconMessages, IconPlus, IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import type { ChatClient, Room } from "@/lib/xenaxio/chat/client";
import { type ChatView, useChatStore } from "@/lib/xenaxio/chat/store";
import { sidebarSections, threadsOf } from "@/lib/xenaxio/chat/view";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { PersonAvatar, presenceOf } from "./common";

const COLLAPSED_KEY = "xenaxio.chat.collapsed";

function useCollapsed(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Private window: forgets, nothing breaks.
    }
  };
  return [collapsed, toggle];
}

function RoomRow({ client, room, active, onOpen }: { client: ChatClient; room: Room; active: boolean; onOpen: () => void }) {
  const name = client.roomName(room);
  const threadHighlights = [...room.threadUnread.values()].reduce((n, c) => n + c.highlights, 0);
  const badge = room.kind === "dm" ? room.notifications : room.highlights + threadHighlights;
  const unread = room.notifications > 0 || badge > 0;
  const partner = room.kind === "dm" ? client.dmPartners(room)[0] : undefined;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
        active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
        !active && !unread && "text-muted-foreground",
        unread && !active && "font-semibold text-foreground",
      )}
    >
      {room.kind === "dm" ? (
        partner ? <PersonAvatar userId={partner} name={name} size="sm" presence={presenceOf(client, partner)} className="scale-[0.8]" /> : <IconMessages size={16} />
      ) : room.joinRule === "public" ? (
        <IconHash size={16} className="shrink-0 opacity-80" />
      ) : (
        <IconLock size={16} className="shrink-0 opacity-80" />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {badge > 0 && <span className={cn("min-w-5 rounded-full px-1.5 text-center text-[11px] font-bold leading-5", active ? "bg-primary-foreground text-primary" : "bg-red-500 text-white")}>{badge}</span>}
    </button>
  );
}

function Section({ id, title, collapsed, onToggle, action, actionLabel, children }: { id: string; title: string; collapsed: boolean; onToggle: (id: string) => void; action?: () => void; actionLabel?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="group flex items-center px-1">
        <button type="button" onClick={() => onToggle(id)} className="flex flex-1 items-center gap-1 rounded px-1 py-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground">
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          {title}
        </button>
        {action && (
          <button type="button" onClick={action} aria-label={actionLabel} title={actionLabel} className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100">
            <IconPlus size={14} />
          </button>
        )}
      </div>
      {!collapsed && <div className="space-y-0.5 px-1">{children}</div>}
    </div>
  );
}

export function ChatSidebar({
  client,
  companyName,
  onJump,
  onCreateChannel,
  onNewMessage,
}: {
  client: ChatClient;
  companyName: string;
  onJump: () => void;
  onCreateChannel: () => void;
  onNewMessage: () => void;
}) {
  const t = useXT();
  const view = useChatStore((s) => s.view);
  const setView = useChatStore((s) => s.setView);
  const setPanel = useChatStore((s) => s.setPanel);
  const [collapsed, toggle] = useCollapsed();
  const [search, setSearch] = useState("");
  const rooms = [...client.rooms.values()];
  const sections = sidebarSections(rooms, (r) => client.roomName(r));
  const threadNews = threadsOf(rooms, client.userId).reduce((n, x) => n + x.unread, 0);
  const isActive = (v: ChatView) => JSON.stringify(v) === JSON.stringify(view);
  const open = (roomId: string) => {
    setView({ kind: "room", roomId });
    setPanel(null);
  };
  const nav = (label: string, icon: React.ReactNode, target: ChatView, badge = 0) => (
    <button
      type="button"
      onClick={() => {
        setView(target);
        setPanel(null);
      }}
      className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm", isActive(target) ? "bg-primary text-primary-foreground" : "hover:bg-accent", badge > 0 && "font-semibold")}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-bold leading-5 text-white">{badge}</span>}
    </button>
  );

  return (
    <nav className="flex h-full min-h-0 w-full flex-col bg-secondary/60 md:w-64 md:border-r md:border-border" aria-label={t("chat.title")}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-base font-bold">{companyName}</span>
        <button type="button" onClick={onNewMessage} className="rounded-md p-1.5 hover:bg-accent" title={t("chat.new_message")} aria-label={t("chat.new_message")}>
          <IconPlus size={18} />
        </button>
      </div>
      <div className="space-y-1 p-2">
        <button type="button" onClick={onJump} className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-sm text-muted-foreground hover:border-foreground/30">
          <IconSearch size={15} />
          <span className="flex-1">{t("chat.jump")}</span>
          <kbd className="rounded border border-border px-1 text-[10px]">Ctrl K</kbd>
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (search.trim()) {
              setView({ kind: "search", query: search.trim() });
              setPanel(null);
            }
          }}
        >
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("chat.search_placeholder")} aria-label={t("chat.search_placeholder")} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </form>
      </div>
      <div className="flex-1 overflow-y-auto pb-4">
        <div className="space-y-0.5 px-2">
          {nav(t("chat.threads"), <IconMessages size={16} />, { kind: "threads" }, threadNews)}
          {nav(t("chat.mentions"), <IconAt size={16} />, { kind: "mentions" })}
          {nav(t("chat.saved"), <IconBookmark size={16} />, { kind: "saved" })}
          {nav(t("chat.browse"), <IconHash size={16} />, { kind: "browse" })}
        </div>

        {sections.invites.length > 0 && (
          <Section id="invites" title={t("chat.invites")} collapsed={false} onToggle={() => {}}>
            {sections.invites.map((r) => (
              <div key={r.id} className="rounded-md border border-border bg-background p-2 text-sm">
                <div className="truncate font-semibold">{client.roomName(r)}</div>
                {r.inviter && <div className="truncate text-xs text-muted-foreground">{t("chat.invited_by", { name: client.displayName(r.inviter, r) })}</div>}
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    className="h-7 rounded bg-primary px-2.5 text-xs text-primary-foreground"
                    onClick={() =>
                      void client
                        .join(r.id)
                        .then(() => open(r.id))
                        .catch(() => toast.error(t("chat.error")))
                    }
                  >
                    {t("chat.accept")}
                  </button>
                  <button type="button" className="h-7 rounded px-2.5 text-xs hover:bg-accent" onClick={() => void client.leave(r.id).catch(() => toast.error(t("chat.error")))}>
                    {t("chat.decline")}
                  </button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {sections.starred.length > 0 && (
          <Section id="starred" title={t("chat.starred")} collapsed={collapsed.has("starred")} onToggle={toggle}>
            {sections.starred.map((r) => (
              <RoomRow key={r.id} client={client} room={r} active={view.kind === "room" && view.roomId === r.id} onOpen={() => open(r.id)} />
            ))}
          </Section>
        )}

        <Section id="channels" title={t("chat.channels")} collapsed={collapsed.has("channels")} onToggle={toggle} action={onCreateChannel} actionLabel={t("chat.add_channel")}>
          {sections.channels.map((r) => (
            <RoomRow key={r.id} client={client} room={r} active={view.kind === "room" && view.roomId === r.id} onOpen={() => open(r.id)} />
          ))}
          <button type="button" onClick={onCreateChannel} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent">
            <IconPlus size={16} />
            {t("chat.add_channel")}
          </button>
        </Section>

        <Section id="direct" title={t("chat.direct")} collapsed={collapsed.has("direct")} onToggle={toggle} action={onNewMessage} actionLabel={t("chat.new_message")}>
          {sections.direct.map((r) => (
            <RoomRow key={r.id} client={client} room={r} active={view.kind === "room" && view.roomId === r.id} onOpen={() => open(r.id)} />
          ))}
          <button type="button" onClick={onNewMessage} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent">
            <IconPlus size={16} />
            {t("chat.new_message")}
          </button>
        </Section>
      </div>
      <button
        type="button"
        onClick={() => setPanel({ kind: "profile", userId: client.userId })}
        className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left hover:bg-accent"
      >
        <PersonAvatar userId={client.userId} name={client.displayName(client.userId)} size="sm" presence="online" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{client.displayName(client.userId)}</span>
          <span className="block truncate text-xs text-muted-foreground">{client.people.get(client.userId)?.statusMsg ?? t("chat.status_set")}</span>
        </span>
      </button>
    </nav>
  );
}
