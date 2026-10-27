"use client";

// Step 43, part B: a channel or direct conversation — header with topic,
// members, pinned messages and settings; the timeline; who is typing; the
// composer. Files can be dropped anywhere on it.
import { IconBell, IconChevronDown, IconHash, IconLock, IconPin, IconStar, IconStarFilled, IconUsers } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import type { ChatClient, Room } from "@/lib/xenaxio/chat/client";
import { plainPreview } from "@/lib/xenaxio/chat/format";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { PersonAvatar, presenceOf, useDisplayName } from "./common";
import { sendFiles, Composer } from "./composer";
import { PeoplePicker, useChatDialogs } from "./dialogs";
import { IntegrationsDialog } from "./integrations";
import { MessageList } from "./message-list";

export function TypingLine({ room }: { room: Room }) {
  const t = useXT();
  const name = useDisplayName();
  const who = room.typing;
  const text = who.length === 0 ? "" : who.length === 1 ? t("chat.typing_one", { name: name(who[0]!) }) : who.length === 2 ? t("chat.typing_two", { a: name(who[0]!), b: name(who[1]!) }) : t("chat.typing_many");
  return <div className="h-5 px-5 text-xs text-muted-foreground">{text}</div>;
}

function NotificationMenu({ client, room, onClose }: { client: ChatClient; room: Room; onClose: () => void }) {
  const t = useXT();
  const [level, setLevel] = useState<"all" | "mentions" | "none" | null>(null);
  useEffect(() => {
    void client.notificationLevel(room.id).then(setLevel);
  }, [client, room.id]);
  const choose = async (next: "all" | "mentions" | "none") => {
    setLevel(next);
    onClose();
    await client.setNotifications(room.id, next).catch(() => toast.error(t("chat.error")));
  };
  return (
    <div className="absolute right-0 top-9 z-40 w-52 rounded-md border border-border bg-popover py-1 shadow-lg" onMouseLeave={onClose}>
      {(["all", "mentions", "none"] as const).map((l) => (
        <button key={l} type="button" onClick={() => void choose(l)} className={cn("flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent", level === l && "font-semibold")}>
          {t(`chat.notify_${l}`)}
          {level === l && <span>✓</span>}
        </button>
      ))}
    </div>
  );
}

function ChannelMenu({ client, room, onClose, onInvite, onIntegrations }: { client: ChatClient; room: Room; onClose: () => void; onInvite: () => void; onIntegrations: () => void }) {
  const t = useXT();
  const { confirm, prompt } = useChatDialogs();
  const setView = useChatStore((s) => s.setView);
  const name = client.roomName(room);
  const isAdmin = client.can(room, "state");
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-accent";
  const run = (job: () => Promise<unknown>) => () => {
    onClose();
    void job().catch(() => toast.error(t("chat.error")));
  };
  return (
    <div className="absolute left-0 top-9 z-40 w-60 rounded-md border border-border bg-popover py-1 shadow-lg" onMouseLeave={onClose}>
      {room.kind === "channel" && client.can(room, "invite") && !room.archived && (
        <button type="button" className={item} onClick={() => (onClose(), onInvite())}>
          {t("chat.invite")}
        </button>
      )}
      {room.kind === "channel" && isAdmin && !room.archived && (
        <>
          <button
            type="button"
            className={item}
            onClick={run(async () => {
              const next = await prompt({ title: t("chat.rename"), defaultValue: room.name ?? "", confirmText: t("chat.save_edit") });
              if (next?.trim()) await client.rename(room.id, next.trim());
            })}
          >
            {t("chat.rename")}
          </button>
          <button
            type="button"
            className={item}
            onClick={run(async () => {
              const next = await prompt({ title: t("chat.set_topic"), defaultValue: room.topic ?? "", confirmText: t("chat.save_edit") });
              if (next !== null) await client.setTopic(room.id, next.trim());
            })}
          >
            {t("chat.set_topic")}
          </button>
        </>
      )}
      {room.kind === "channel" && !room.archived && (
        <button type="button" className={item} onClick={() => (onClose(), onIntegrations())}>
          {t("chat.hooks_menu")}
        </button>
      )}
      {room.kind === "channel" && (
        <button
          type="button"
          className={item}
          onClick={run(async () => {
            if (await confirm({ title: t("chat.leave"), message: t("chat.leave_confirm", { name }), confirmText: t("chat.leave") })) {
              await client.leave(room.id);
              setView({ kind: "home" });
            }
          })}
        >
          {t("chat.leave")}
        </button>
      )}
      {room.kind === "channel" && isAdmin && !room.archived && (
        <button
          type="button"
          className={cn(item, "text-destructive")}
          onClick={run(async () => {
            if (await confirm({ title: t("chat.archive"), message: t("chat.archive_confirm", { name }), confirmText: t("chat.archive"), variant: "destructive" })) await client.archive(room.id);
          })}
        >
          {t("chat.archive")}
        </button>
      )}
    </div>
  );
}

function PinnedMenu({ room, onClose }: { room: Room; onClose: () => void }) {
  const t = useXT();
  const name = useDisplayName();
  const setFocus = useChatStore((s) => s.setFocus);
  return (
    <div className="absolute right-0 top-9 z-40 w-80 rounded-md border border-border bg-popover py-1 shadow-lg" onMouseLeave={onClose}>
      {room.pinned.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">{t("chat.pinned_none")}</div>}
      {room.pinned.map((id) => {
        const m = room.byId.get(id);
        return (
          <button key={id} type="button" className="block w-full px-3 py-2 text-left hover:bg-accent" onClick={() => (onClose(), setFocus({ roomId: room.id, eventId: id }))}>
            <span className="block text-xs font-semibold">{m ? name(m.sender) : ""}</span>
            <span className="block truncate text-sm">{m ? plainPreview(m.content, 90) : id}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RoomView({ client, room, focusId }: { client: ChatClient; room: Room; focusId: string | null }) {
  const t = useXT();
  const locale = useLocale();
  const setPanel = useChatStore((s) => s.setPanel);
  const setEditing = useChatStore((s) => s.setEditing);
  const [menu, setMenu] = useState<"channel" | "notify" | "pinned" | null>(null);
  const [inviting, setInviting] = useState(false);
  const [integrations, setIntegrations] = useState(false);
  const [dragging, setDragging] = useState(false);
  const roomName = client.roomName(room);
  const partners = room.kind === "dm" ? client.dmPartners(room) : [];
  const joined = [...room.members.values()].filter((m) => m.membership === "join").length;
  const starred = !!room.tags["m.favourite"];

  useEffect(() => {
    if (room.kind === "channel") void client.loadMembers(room.id).catch(() => undefined);
  }, [client, room.id, room.kind]);

  const editLast = () => {
    const mine = [...room.timeline].reverse().find((m) => m.sender === client.userId && m.type === "m.room.message" && !m.redacted && m.content.msgtype === "m.text");
    if (mine) setEditing(mine.id);
  };

  const toggleStar = () => client.setFavourite(room.id, !starred).catch(() => toast.error(t("chat.error")));

  const beginning =
    room.kind === "dm" ? (
      <div className="px-5 pb-4 pt-8">
        {partners[0] && <PersonAvatar userId={partners[0]} name={roomName} size="lg" />}
        <p className="mt-2 text-sm text-muted-foreground">{t("chat.beginning_dm", { name: roomName })}</p>
      </div>
    ) : (
      <div className="px-5 pb-4 pt-8">
        <h2 className="text-xl font-bold">
          {room.joinRule === "public" ? "#" : "🔒 "}
          {roomName}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("chat.beginning", { name: roomName })}</p>
        {room.topic && <p className="mt-1 text-sm">{room.topic}</p>}
      </div>
    );

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files") && client.can(room, "send")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void sendFiles(client, room.id, [...e.dataTransfer.files], locale);
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="relative min-w-0">
          <button type="button" onClick={() => setMenu(menu === "channel" ? null : "channel")} className="flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-base font-bold hover:bg-accent">
            {room.kind === "dm" ? (
              partners[0] && <PersonAvatar userId={partners[0]} name={roomName} size="sm" presence={presenceOf(client, partners[0])} className="mr-1" />
            ) : room.joinRule === "public" ? (
              <IconHash size={18} />
            ) : (
              <IconLock size={18} />
            )}
            <span className="truncate">{roomName}</span>
            <IconChevronDown size={14} className="text-muted-foreground" />
          </button>
          {menu === "channel" && <ChannelMenu client={client} room={room} onClose={() => setMenu(null)} onInvite={() => setInviting(true)} onIntegrations={() => setIntegrations(true)} />}
        </div>
        <button type="button" onClick={() => void toggleStar()} className="rounded p-1 text-muted-foreground hover:bg-accent" title={starred ? t("chat.unstar") : t("chat.star")} aria-label={starred ? t("chat.unstar") : t("chat.star")}>
          {starred ? <IconStarFilled size={16} className="text-amber-500" /> : <IconStar size={16} />}
        </button>
        {room.topic && <span className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">{room.topic}</span>}
        {room.kind === "dm" && partners[0] && client.people.get(partners[0])?.statusMsg && (
          <span className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">{client.people.get(partners[0])?.statusMsg}</span>
        )}
        <span className="flex-1" />
        {room.kind === "channel" && (
          <button type="button" onClick={() => setPanel({ kind: "members", roomId: room.id })} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent" title={t("chat.members")}>
            <IconUsers size={16} />
            <span className="tabular-nums">{joined}</span>
          </button>
        )}
        <span className="relative">
          <button type="button" onClick={() => setMenu(menu === "pinned" ? null : "pinned")} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent" title={t("chat.pinned")} aria-label={t("chat.pinned")}>
            <IconPin size={16} />
            {room.pinned.length > 0 && <span className="tabular-nums">{room.pinned.length}</span>}
          </button>
          {menu === "pinned" && <PinnedMenu room={room} onClose={() => setMenu(null)} />}
        </span>
        <span className="relative">
          <button type="button" onClick={() => setMenu(menu === "notify" ? null : "notify")} className="rounded p-1.5 text-muted-foreground hover:bg-accent" title={t("chat.notifications")} aria-label={t("chat.notifications")}>
            <IconBell size={16} />
          </button>
          {menu === "notify" && <NotificationMenu client={client} room={room} onClose={() => setMenu(null)} />}
        </span>
      </header>

      <MessageList room={room} client={client} messages={room.kind === "dm" ? room.timeline.filter((m) => m.type !== "m.room.member") : room.timeline} focusId={focusId} header={beginning} />
      <TypingLine room={room} />
      <Composer
        room={room}
        client={client}
        locale={locale}
        placeholder={t("chat.composer_placeholder", { name: room.kind === "dm" ? roomName : `#${roomName}` })}
        onEditLast={editLast}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
          {t("chat.drop_files")}
        </div>
      )}
      {integrations && <IntegrationsDialog room={room} roomName={roomName} onClose={() => setIntegrations(false)} />}
      {inviting && (
        <PeoplePicker
          title={t("chat.invite_title", { name: roomName })}
          action={t("chat.invite")}
          client={client}
          max={20}
          exclude={[...room.members.values()].filter((m) => m.membership === "join" || m.membership === "invite").map((m) => m.userId)}
          onClose={() => setInviting(false)}
          onDone={async (ids) => {
            for (const id of ids) await client.invite(room.id, id);
          }}
        />
      )}
    </div>
  );
}
