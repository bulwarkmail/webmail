"use client";

// Step 43, part B: the chat's list views — threads, mentions, saved
// messages, the channel directory, search results and the start page.
import { IconHash, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatClient, Message } from "@/lib/xenaxio/chat/client";
import { mentionsUser, plainPreview } from "@/lib/xenaxio/chat/format";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { mentionsOf, parseSearch, threadsOf } from "@/lib/xenaxio/chat/view";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { PersonAvatar, useChatTime, useDisplayName } from "./common";

function ViewFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <h1 className="truncate text-base font-bold">{title}</h1>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** A message in a list: who, where, when, the text; opens it in its channel. */
function MessageCard({ client, message, extra, onOpen }: { client: ChatClient; message: Message; extra?: React.ReactNode; onOpen?: () => void }) {
  const t = useXT();
  const name = useDisplayName();
  const { relative } = useChatTime();
  const setView = useChatStore((s) => s.setView);
  const setFocus = useChatStore((s) => s.setFocus);
  const room = client.rooms.get(message.roomId);
  const open =
    onOpen ??
    (() => {
      setView({ kind: "room", roomId: message.roomId });
      setFocus({ roomId: message.roomId, eventId: message.threadRoot ?? message.id });
    });
  return (
    <button type="button" onClick={open} className="flex w-full gap-3 border-b border-border px-5 py-3 text-left hover:bg-muted/40">
      <PersonAvatar userId={message.sender} name={name(message.sender)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-bold">{name(message.sender)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {room ? t("chat.in_channel", { name: room.kind === "dm" ? client.roomName(room) : `#${client.roomName(room)}` }) : ""} · {relative(message.ts)}
          </span>
        </span>
        <span className="mt-0.5 block text-sm">{message.redacted ? t("chat.deleted") : plainPreview(message.content, 300)}</span>
        {extra}
      </span>
    </button>
  );
}

export function ThreadsView({ client }: { client: ChatClient }) {
  const t = useXT();
  const setPanel = useChatStore((s) => s.setPanel);
  const items = threadsOf([...client.rooms.values()], client.userId);
  return (
    <ViewFrame title={t("chat.threads")}>
      {items.length === 0 && <p className="p-5 text-sm text-muted-foreground">{t("chat.threads_empty")}</p>}
      {items.map(({ room, root, unread }) => (
        <MessageCard
          key={root.id}
          client={client}
          message={root}
          onOpen={() => setPanel({ kind: "thread", roomId: room.id, rootId: root.id })}
          extra={
            <span className="mt-1 block text-xs font-semibold text-primary">
              {root.thread!.count === 1 ? t("chat.reply_one") : t("chat.replies", { count: root.thread!.count })}
              {unread > 0 && <span className="ml-2 rounded-full bg-red-500 px-1.5 text-white">{unread}</span>}
            </span>
          }
        />
      ))}
    </ViewFrame>
  );
}

export function MentionsView({ client }: { client: ChatClient }) {
  const t = useXT();
  const items = mentionsOf([...client.rooms.values()], (m) => m.sender !== client.userId && mentionsUser(m.content, client.userId));
  return (
    <ViewFrame title={t("chat.mentions")}>
      {items.length === 0 && <p className="p-5 text-sm text-muted-foreground">{t("chat.mentions_empty")}</p>}
      {items.map((m) => (
        <MessageCard key={m.id} client={client} message={m} />
      ))}
    </ViewFrame>
  );
}

export function SavedView({ client }: { client: ChatClient }) {
  const t = useXT();
  const [messages, setMessages] = useState<Message[]>([]);
  const key = client.saved.map((s) => s.eventId).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(client.saved.map((s) => client.fetchMessage(s.roomId, s.eventId))).then((list) => {
      if (!cancelled) setMessages(list.filter((m): m is Message => !!m));
    });
    return () => {
      cancelled = true;
    };
  }, [client, key]);
  return (
    <ViewFrame title={t("chat.saved")}>
      {client.saved.length === 0 && <p className="p-5 text-sm text-muted-foreground">{t("chat.saved_empty")}</p>}
      {messages.map((m) => (
        <MessageCard key={m.id} client={client} message={m} />
      ))}
    </ViewFrame>
  );
}

export function BrowseView({ client, onCreate }: { client: ChatClient; onCreate: () => void }) {
  const t = useXT();
  const setView = useChatStore((s) => s.setView);
  const [channels, setChannels] = useState<Awaited<ReturnType<ChatClient["publicChannels"]>> | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void client
      .publicChannels()
      .then(setChannels)
      .catch(() => setChannels([]));
  }, [client]);
  const shown = useMemo(() => (channels ?? []).filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()) || (c.topic ?? "").toLowerCase().includes(query.trim().toLowerCase())), [channels, query]);
  return (
    <ViewFrame title={t("chat.browse_title")}>
      <div className="flex gap-2 border-b border-border p-4">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-input px-2 focus-within:ring-2 focus-within:ring-ring">
          <IconSearch size={16} className="text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.browse_search")} className="h-9 flex-1 bg-transparent text-sm focus:outline-none" />
        </div>
        <button type="button" onClick={onCreate} className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground">
          {t("chat.create_title")}
        </button>
      </div>
      {channels && shown.length === 0 && <p className="p-5 text-sm text-muted-foreground">{t("chat.browse_empty")}</p>}
      {shown.map((c) => {
        const joined = client.rooms.get(c.roomId)?.membership === "join";
        return (
          <div key={c.roomId} className="flex items-center gap-3 border-b border-border px-5 py-3">
            <IconHash size={18} className="text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{c.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("chat.members_count", { count: c.members })}
                {c.topic ? ` · ${c.topic}` : ""}
              </div>
            </div>
            <button
              type="button"
              className="h-8 rounded-md border border-border px-3 text-sm hover:bg-accent"
              onClick={async () => {
                try {
                  if (!joined) await client.join(c.roomId);
                  setView({ kind: "room", roomId: c.roomId });
                } catch {
                  toast.error(t("chat.error"));
                }
              }}
            >
              {joined ? t("chat.browse_open") : t("chat.browse_join")}
            </button>
          </div>
        );
      })}
    </ViewFrame>
  );
}

export function SearchView({ client, query }: { client: ChatClient; query: string }) {
  const t = useXT();
  const colleagues = useChatStore((s) => s.colleagues);
  const [hits, setHits] = useState<Message[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHits(null);
    const { term, inChannel, from } = parseSearch(query);
    const room = inChannel ? [...client.rooms.values()].find((r) => client.roomName(r).toLowerCase() === inChannel.toLowerCase()) : undefined;
    const sender = from
      ? ([...colleagues.values()].find((c) => c.displayName.toLowerCase().includes(from.toLowerCase()) || c.email.toLowerCase().startsWith(from.toLowerCase()))?.address ?? `@${from}`)
      : undefined;
    void client
      .search(term || query, { ...(room ? { rooms: [room.id] } : {}), ...(sender ? { senders: [sender] } : {}) })
      .then((r) => !cancelled && setHits(r.map((h) => h.message)))
      .catch(() => !cancelled && setHits([]));
    return () => {
      cancelled = true;
    };
  }, [client, query, colleagues]);
  return (
    <ViewFrame title={t("chat.search_title", { query })}>
      {hits === null && <p className="p-5 text-sm text-muted-foreground">{t("chat.loading")}</p>}
      {hits?.length === 0 && (
        <p className="p-5 text-sm text-muted-foreground">
          {t("chat.search_none")} {t("chat.search_words")}
        </p>
      )}
      {hits?.map((m) => (
        <MessageCard key={m.id} client={client} message={m} />
      ))}
    </ViewFrame>
  );
}

export function HomeView() {
  const t = useXT();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-bold">{t("chat.home_title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("chat.home_text")}</p>
        <p className="mt-4 text-xs text-muted-foreground">{t("chat.shortcuts")}</p>
      </div>
    </div>
  );
}
