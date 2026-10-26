"use client";

// Step 43, part B: the right-hand panel — a thread, a channel's members or a
// colleague's profile.
import { IconX } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import type { ChatClient } from "@/lib/xenaxio/chat/client";
import { type SidePanel, useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { PersonAvatar, presenceOf, useColleague, useDisplayName } from "./common";
import { Composer } from "./composer";
import { ChatMessage } from "./message";
import { MessageList } from "./message-list";
import { TypingLine } from "./room-view";

function PanelFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const t = useXT();
  const setPanel = useChatStore((s) => s.setPanel);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background md:w-[380px]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold">{title}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <button type="button" onClick={() => setPanel(null)} className="rounded p-1 hover:bg-accent" aria-label={t("chat.close")}>
          <IconX size={18} />
        </button>
      </header>
      {children}
    </aside>
  );
}

function ThreadPanel({ client, roomId, rootId }: { client: ChatClient; roomId: string; rootId: string }) {
  const t = useXT();
  const locale = useLocale();
  const room = client.rooms.get(roomId);
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    void client.loadThread(roomId, rootId).catch(() => setError(true));
  }, [client, roomId, rootId]);
  if (!room) return null;
  const root = room.byId.get(rootId);
  const replies = room.threads.get(rootId) ?? [];
  return (
    <PanelFrame title={t("chat.thread")} subtitle={client.roomName(room)}>
      <MessageList
        room={room}
        client={client}
        messages={replies}
        inThread
        threadRoot={rootId}
        header={
          root ? (
            <div className="border-b border-border pb-2">
              <ChatMessage message={root} room={room} client={client} continued={false} inThread />
              {replies.length > 0 && <div className="px-5 pt-2 text-xs text-muted-foreground">{replies.length === 1 ? t("chat.reply_one") : t("chat.replies", { count: replies.length })}</div>}
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">{t("chat.error")}</div>
          ) : null
        }
      />
      <TypingLine room={room} />
      <Composer room={room} client={client} threadRoot={rootId} locale={locale} placeholder={t("chat.thread_placeholder")} />
    </PanelFrame>
  );
}

function MembersPanel({ client, roomId }: { client: ChatClient; roomId: string }) {
  const t = useXT();
  const name = useDisplayName();
  const setPanel = useChatStore((s) => s.setPanel);
  const room = client.rooms.get(roomId);
  useEffect(() => {
    void client.loadMembers(roomId).catch(() => undefined);
  }, [client, roomId]);
  if (!room) return null;
  const members = [...room.members.values()].filter((m) => m.membership === "join").sort((a, b) => name(a.userId).localeCompare(name(b.userId)));
  return (
    <PanelFrame title={t("chat.members")} subtitle={t("chat.members_count", { count: members.length })}>
      <div className="flex-1 overflow-y-auto p-2">
        {members.map((m) => (
          <button key={m.userId} type="button" onClick={() => setPanel({ kind: "profile", userId: m.userId })} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent">
            <PersonAvatar userId={m.userId} name={name(m.userId)} size="sm" presence={presenceOf(client, m.userId)} />
            <span className="min-w-0 flex-1 truncate text-sm">
              {name(m.userId)}
              {m.userId === client.userId && <span className="text-muted-foreground"> ({t("chat.you")})</span>}
            </span>
            {client.powerOf(room, m.userId) >= 100 && <span className="text-[10px] uppercase text-muted-foreground">admin</span>}
          </button>
        ))}
      </div>
    </PanelFrame>
  );
}

const STATUS_PRESETS = ["meeting", "lunch", "vacation", "sick", "remote"] as const;

function ProfilePanel({ client, userId }: { client: ChatClient; userId: string }) {
  const t = useXT();
  const name = useDisplayName();
  const colleague = useColleague(userId);
  const setView = useChatStore((s) => s.setView);
  const setPanel = useChatStore((s) => s.setPanel);
  const person = client.people.get(userId);
  const me = userId === client.userId;
  const [status, setStatus] = useState(person?.statusMsg ?? "");
  const presence = presenceOf(client, userId);
  const presenceLabel = presence === "online" ? t("chat.online") : presence === "unavailable" ? t("chat.away") : t("chat.offline");
  const saveStatus = async (value: string | null) => {
    try {
      await client.setStatus(value);
      setStatus(value ?? "");
    } catch {
      toast.error(t("chat.error"));
    }
  };
  return (
    <PanelFrame title={name(userId)}>
      <div className="flex-1 overflow-y-auto p-5">
        <PersonAvatar userId={userId} name={name(userId)} size="lg" presence={presence} />
        <h3 className="mt-3 text-lg font-bold">{name(userId)}</h3>
        <div className="text-sm text-muted-foreground">{presenceLabel}</div>
        {person?.statusMsg && !me && <div className="mt-2 text-sm">{person.statusMsg}</div>}
        {colleague?.email && (
          <div className="mt-4">
            <div className="text-xs font-medium text-muted-foreground">{t("chat.profile_email")}</div>
            <a href={`mailto:${colleague.email}`} className="text-sm text-primary hover:underline">
              {colleague.email}
            </a>
          </div>
        )}
        {!me && (
          <button
            type="button"
            className="mt-5 h-9 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
            onClick={async () => {
              try {
                const roomId = await client.openDirect([userId]);
                setView({ kind: "room", roomId });
                setPanel(null);
              } catch {
                toast.error(t("chat.error"));
              }
            }}
          >
            {t("chat.message_person")}
          </button>
        )}
        {me && (
          <div className="mt-5">
            <div className="text-sm font-medium">{t("chat.status")}</div>
            <div className="mt-1 flex gap-2">
              <input
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder={t("chat.status_placeholder")}
                maxLength={100}
                className="h-9 flex-1 rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && void saveStatus(status.trim() || null)}
              />
              <button type="button" onClick={() => void saveStatus(status.trim() || null)} className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground">
                {t("chat.save_edit")}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {STATUS_PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => void saveStatus(t(`chat.status_presets_${p}`))} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-accent">
                  {t(`chat.status_presets_${p}`)}
                </button>
              ))}
              {person?.statusMsg && (
                <button type="button" onClick={() => void saveStatus(null)} className="rounded-full px-2.5 py-1 text-xs text-muted-foreground underline">
                  {t("chat.status_clear")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </PanelFrame>
  );
}

export function ChatSidePanel({ client, panel }: { client: ChatClient; panel: SidePanel }) {
  if (!panel) return null;
  if (panel.kind === "thread") return <ThreadPanel key={`${panel.roomId}|${panel.rootId}`} client={client} roomId={panel.roomId} rootId={panel.rootId} />;
  if (panel.kind === "members") return <MembersPanel client={client} roomId={panel.roomId} />;
  return <ProfilePanel key={panel.userId} client={client} userId={panel.userId} />;
}
