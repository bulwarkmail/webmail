"use client";

// Step 43, part B: one message as Slack shows it — avatar and name on the
// first of a group, text with mentions, files, reactions, the thread line and
// a toolbar on hover.
import { IconBookmark, IconBookmarkFilled, IconDots, IconMessageCircle, IconMoodPlus, IconPin } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { useCallback, useState } from "react";
import { mediaUrl } from "@/lib/xenaxio/chat/api";
import type { ChatClient, Message, Room } from "@/lib/xenaxio/chat/client";
import { serverOfUser } from "@/lib/xenaxio/chat/client";
import { reportMessage } from "@/lib/xenaxio/chat/api";
import { appOf, messageHtml, mentionsUser, sharedEmailOf, textContent } from "@/lib/xenaxio/chat/format";
import { useChatDialogs } from "./dialogs";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { formatSize, messageLink, PersonAvatar, useChatTime, useDisplayName } from "./common";
import { EmailCard } from "./email-card";
import { EmojiPicker, quickReactions } from "./emoji-picker";

interface Props {
  message: Message;
  room: Room;
  client: ChatClient;
  continued: boolean;
  inThread?: boolean;
  highlighted?: boolean;
}

function SystemLine({ message, room }: { message: Message; room: Room }) {
  const t = useXT();
  const name = useDisplayName();
  const { time } = useChatTime();
  const who = name(message.type === "m.room.member" ? (message.stateKey ?? message.sender) : message.sender);
  let text = "";
  if (message.type === "m.room.member") text = t(message.content.membership === "join" ? "chat.joined" : "chat.left", { name: who });
  else if (message.type === "m.room.name") text = t("chat.renamed", { name: who, value: String(message.content.name ?? "") });
  else if (message.type === "m.room.topic") text = t("chat.topic_changed", { name: who, value: String(message.content.topic ?? "") });
  else text = t("chat.archived_event", { name: who });
  return (
    <div className="flex items-baseline gap-2 px-5 py-1 text-xs text-muted-foreground" data-room={room.id}>
      <span className="w-9 shrink-0 text-right tabular-nums">{time(message.ts)}</span>
      <span>{text}</span>
    </div>
  );
}

function Attachment({ content }: { content: Record<string, unknown> }) {
  const t = useXT();
  const info = (content.info ?? {}) as { w?: number; h?: number; size?: number; mimetype?: string };
  const name = String(content.filename ?? content.body ?? t("chat.file"));
  const url = typeof content.url === "string" ? content.url : null;
  const download = mediaUrl(url, { filename: name });
  if (content.msgtype === "m.image" && url) {
    const w = info.w ?? 320;
    const h = info.h ?? 240;
    const scale = Math.min(1, 360 / w, 300 / h);
    return (
      <a href={download ?? "#"} target="_blank" rel="noopener noreferrer" className="block mt-1 w-fit">
        {/* Thumbnails come from the chat server through the platform (cookie). */}
        <img
          src={mediaUrl(url, { thumbnail: { width: 720, height: 600 } }) ?? ""}
          alt={name}
          width={Math.round(w * scale)}
          height={Math.round(h * scale)}
          loading="lazy"
          className="rounded-md border border-border object-cover bg-muted max-w-full"
        />
      </a>
    );
  }
  if (content.msgtype === "m.video" && download) {
    return <video controls preload="metadata" src={download} className="mt-1 max-w-sm rounded-md border border-border" />;
  }
  if (content.msgtype === "m.audio" && download) {
    return <audio controls preload="metadata" src={download} className="mt-1" />;
  }
  return (
    <a href={download ?? "#"} target="_blank" rel="noopener noreferrer" className="mt-1 flex w-fit max-w-sm items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-accent">
      <span className="text-xl">📎</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-muted-foreground">
          {formatSize(info.size)} · {t("chat.download")}
        </span>
      </span>
    </a>
  );
}

function Body({ message, me, onMention }: { message: Message; me: string; onMention: (userId: string) => void }) {
  const t = useXT();
  const name = useDisplayName();
  if (message.redacted) return <div className="text-sm italic text-muted-foreground">{t("chat.deleted")}</div>;
  const c = message.content;
  if (c.msgtype === "m.image" || c.msgtype === "m.file" || c.msgtype === "m.video" || c.msgtype === "m.audio") return <Attachment content={c} />;
  // An e-mail shared into the chat: what the person wrote, then the card.
  const email = sharedEmailOf(c);
  const html = email ? (email.note ? messageHtml({ body: email.note }) : "") : messageHtml(c);
  return (
    <div
      className={cn(
        "chat-body text-sm leading-relaxed break-words [&_a[href]]:text-primary [&_a[href]]:underline-offset-2 hover:[&_a[href]]:underline",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_pre]:my-1 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_.chat-mention]:rounded [&_.chat-mention]:bg-primary/10 [&_.chat-mention]:px-0.5 [&_.chat-mention]:text-primary [&_.chat-mention]:cursor-pointer [&_.chat-mention]:font-medium",
        mentionsUser(c, me) && "[&_.chat-mention]:bg-amber-200/60 dark:[&_.chat-mention]:bg-amber-500/30",
        c.msgtype === "m.emote" && "italic",
      )}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest("[data-mention]");
        if (el) onMention(el.getAttribute("data-mention") as string);
      }}
    >
      {c.msgtype === "m.emote" && <span>* {name(message.sender)} </span>}
      {html && <span dangerouslySetInnerHTML={{ __html: html }} />}
      {message.edited && <span className="ml-1 text-xs text-muted-foreground">{t("chat.edited")}</span>}
      {email && <EmailCard email={email} />}
    </div>
  );
}

function Reactions({ message, client }: { message: Message; client: ChatClient }) {
  const name = useDisplayName();
  const t = useXT();
  const entries = Object.entries(message.reactions);
  const [picker, setPicker] = useState(false);
  if (!entries.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([key, who]) => {
        const mine = who.includes(client.userId);
        return (
          <button
            key={key}
            type="button"
            title={t("chat.reacted", { names: who.map((u) => (u === client.userId ? t("chat.you") : name(u))).join(", "), emoji: key })}
            onClick={() => void client.toggleReaction(message.roomId, message.id, key).catch(() => toast.error(t("chat.error")))}
            className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs", mine ? "border-primary bg-primary/10 text-primary" : "border-border bg-muted/50 hover:border-foreground/30")}
          >
            <span>{key}</span>
            <span className="tabular-nums">{who.length}</span>
          </button>
        );
      })}
      <span className="relative">
        <button type="button" aria-label={t("chat.react")} onClick={() => setPicker(true)} className="inline-flex h-6 w-7 items-center justify-center rounded-full border border-border text-muted-foreground hover:text-foreground">
          <IconMoodPlus size={14} />
        </button>
        {picker && (
          <EmojiPicker
            className="absolute bottom-8 left-0"
            onClose={() => setPicker(false)}
            onPick={(e) => {
              setPicker(false);
              void client.toggleReaction(message.roomId, message.id, e);
            }}
          />
        )}
      </span>
    </div>
  );
}

function ThreadLine({ message }: { message: Message }) {
  const t = useXT();
  const { relative } = useChatTime();
  const name = useDisplayName();
  const setPanel = useChatStore((s) => s.setPanel);
  const thread = message.thread;
  if (!thread?.count) return null;
  return (
    <button
      type="button"
      onClick={() => setPanel({ kind: "thread", roomId: message.roomId, rootId: message.id })}
      className="mt-1 flex items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-xs hover:border-border hover:bg-background"
    >
      <span className="flex -space-x-1">
        {thread.participants.slice(0, 3).map((u) => (
          <PersonAvatar key={u} userId={u} name={name(u)} size="sm" className="scale-75" />
        ))}
      </span>
      <span className="font-semibold text-primary">{thread.count === 1 ? t("chat.reply_one") : t("chat.replies", { count: thread.count })}</span>
      {thread.latestTs > 0 && <span className="text-muted-foreground">{t("chat.last_reply", { time: relative(thread.latestTs) })}</span>}
    </button>
  );
}

function Editor({ message, client, onDone }: { message: Message; client: ChatClient; onDone: () => void }) {
  const t = useXT();
  const colleagues = useChatStore((s) => s.colleagues);
  const [text, setText] = useState(String(message.content.body ?? ""));
  const save = async () => {
    const body = text.trim();
    if (!body || body === message.content.body) return onDone();
    const mentions = [...colleagues.values()].map((c) => ({ userId: c.address, displayName: c.displayName }));
    try {
      await client.edit(message.roomId, message.id, textContent(body, mentions));
    } catch {
      toast.error(t("chat.error"));
    }
    onDone();
  };
  return (
    <div className="mt-1 rounded-md border border-ring bg-background p-2">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(8, text.split("\n").length + 1)}
        className="w-full resize-none bg-transparent text-sm focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") onDone();
        }}
      />
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" onClick={onDone} className="h-7 rounded-md px-3 text-xs hover:bg-accent">
          {t("chat.cancel")}
        </button>
        <button type="button" onClick={() => void save()} className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground">
          {t("chat.save_edit")}
        </button>
      </div>
    </div>
  );
}

function MoreMenu({ message, room, client, onEdit, onReport, onClose }: { message: Message; room: Room; client: ChatClient; onEdit: () => void; onReport: () => Promise<void>; onClose: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const mine = message.sender === client.userId;
  const textual = !message.redacted && (message.content.msgtype === "m.text" || message.content.msgtype === "m.emote");
  const pinned = room.pinned.includes(message.id);
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-accent";
  const run = (job: () => Promise<unknown> | void) => () => {
    onClose();
    void Promise.resolve(job()).catch(() => toast.error(t("chat.error")));
  };
  return (
    <div className="absolute right-0 top-8 z-40 w-52 rounded-md border border-border bg-popover py-1 shadow-lg" onMouseLeave={onClose}>
      {mine && textual && (
        <button type="button" className={item} onClick={run(onEdit)}>
          {t("chat.edit")}
        </button>
      )}
      {client.can(room, "pin") && !message.redacted && (
        <button type="button" className={item} onClick={run(() => client.setPinned(room.id, message.id, !pinned))}>
          {pinned ? t("chat.unpin") : t("chat.pin")}
        </button>
      )}
      <button
        type="button"
        className={item}
        onClick={run(async () => {
          await navigator.clipboard.writeText(messageLink(locale, room.id, message.id));
          toast.success(t("chat.copied"));
        })}
      >
        {t("chat.copy_link")}
      </button>
      {textual && (
        <button type="button" className={item} onClick={run(() => navigator.clipboard.writeText(String(message.content.body ?? "")))}>
          {t("chat.copy_text")}
        </button>
      )}
      {!mine && !message.redacted && (
        <button type="button" className={item} onClick={run(onReport)}>
          {t("chat.report")}
        </button>
      )}
      {(mine || client.can(room, "redact")) && !message.redacted && (
        <button
          type="button"
          className={cn(item, "text-destructive")}
          onClick={run(async () => {
            if (window.confirm(t("chat.delete_confirm"))) await client.remove(room.id, message.id);
          })}
        >
          {t("chat.delete")}
        </button>
      )}
    </div>
  );
}

// Not memoised: the client updates messages in place (edits, reactions).
export function ChatMessage({ message, room, client, continued, inThread, highlighted }: Props) {
  const t = useXT();
  const name = useDisplayName();
  const { time, full } = useChatTime();
  const setPanel = useChatStore((s) => s.setPanel);
  const editing = useChatStore((s) => s.editing === message.id);
  const setEditingId = useChatStore((s) => s.setEditing);
  const setEditing = useCallback((on: boolean) => setEditingId(on ? message.id : null), [setEditingId, message.id]);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const saved = client.saved.some((s) => s.eventId === message.id);
  const openProfile = useCallback((userId: string) => setPanel({ kind: "profile", userId }), [setPanel]);
  const { prompt } = useChatDialogs();
  // Part E: a report goes to the company's admins (they can block the sender's server).
  const report = async () => {
    const reason = await prompt({ title: t("chat.report_title"), message: t("chat.report_text"), confirmText: t("chat.report") });
    if (reason === null) return;
    await reportMessage({ roomId: room.id, eventId: message.id, sender: message.sender, excerpt: String(message.content.body ?? "").slice(0, 500), reason: reason.trim() });
    toast.success(t("chat.report_sent"));
  };

  if (message.type !== "m.room.message") return <SystemLine message={message} room={room} />;
  const real = !message.id.startsWith("~");
  // Part D: an integration posts under its own name with an "App" label.
  const app = appOf(message.content, message.sender);
  const author = app?.name ?? name(message.sender);
  const pinned = room.pinned.includes(message.id);

  return (
    <div
      id={`msg-${message.id}`}
      className={cn("group relative flex gap-2 px-5 hover:bg-muted/40", continued ? "py-0.5" : "pt-2 pb-0.5", highlighted && "bg-amber-100/60 dark:bg-amber-500/10", pinned && !inThread && "bg-amber-50/50 dark:bg-amber-500/5")}
    >
      <div className="w-9 shrink-0">
        {continued ? (
          <span className="invisible block pt-1 text-right text-[10px] text-muted-foreground tabular-nums group-hover:visible" title={full(message.ts)}>
            {time(message.ts)}
          </span>
        ) : (
          app?.icon ? (
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-xl" aria-hidden>
              {app.icon}
            </span>
          ) : (
            <button type="button" onClick={() => openProfile(message.sender)} aria-label={author}>
              <PersonAvatar userId={message.sender} name={author} />
            </button>
          )
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <button type="button" onClick={() => openProfile(message.sender)} className="text-sm font-bold hover:underline">
              {author}
            </button>
            {app && <span className="rounded bg-muted px-1 text-[10px] font-semibold uppercase text-muted-foreground">{t("chat.app")}</span>}
            {/* Part E: people of other companies carry their domain, as in Slack Connect. */}
            {!app && client.isExternalUser(message.sender) && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">{serverOfUser(message.sender)}</span>}
            <span className="text-xs text-muted-foreground tabular-nums" title={full(message.ts)}>
              {time(message.ts)}
            </span>
            {pinned && !inThread && (
              <span className="inline-flex items-center gap-0.5 text-xs text-amber-600">
                <IconPin size={12} />
                {t("chat.pinned")}
              </span>
            )}
          </div>
        )}
        {editing ? <Editor message={message} client={client} onDone={() => setEditing(false)} /> : <Body message={message} me={client.userId} onMention={openProfile} />}
        {message.status === "sending" && <div className="text-xs text-muted-foreground">{t("chat.sending")}</div>}
        {message.status === "failed" && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <span>{t("chat.failed")}</span>
            <button type="button" className="underline" onClick={() => void client.retry(room.id, message.id)}>
              {t("chat.retry")}
            </button>
            <button type="button" className="underline" onClick={() => client.discard(room.id, message.id)}>
              {t("chat.discard")}
            </button>
          </div>
        )}
        {typeof message.content["com.xenaxio.thread"] === "string" && !inThread && (
          <button type="button" onClick={() => setPanel({ kind: "thread", roomId: room.id, rootId: message.content["com.xenaxio.thread"] as string })} className="mt-0.5 text-xs text-muted-foreground hover:underline">
            {t("chat.from_thread")}
          </button>
        )}
        <Reactions message={message} client={client} />
        {!inThread && <ThreadLine message={message} />}
      </div>

      {real && !message.redacted && !editing && (
        <div className={cn("absolute -top-3 right-4 z-10 hidden items-center rounded-md border border-border bg-background shadow-sm group-hover:flex", (picker || menu) && "flex")}>
          {quickReactions().map((e) => (
            <button key={e} type="button" className="h-8 w-8 rounded hover:bg-accent" onClick={() => void client.toggleReaction(room.id, message.id, e)} aria-label={e}>
              {e}
            </button>
          ))}
          <span className="relative">
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded hover:bg-accent" onClick={() => setPicker(true)} aria-label={t("chat.react")} title={t("chat.react")}>
              <IconMoodPlus size={16} />
            </button>
            {picker && (
              <EmojiPicker
                className="absolute right-0 top-9"
                onClose={() => setPicker(false)}
                onPick={(e) => {
                  setPicker(false);
                  void client.toggleReaction(room.id, message.id, e);
                }}
              />
            )}
          </span>
          {!inThread && (
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded hover:bg-accent"
              onClick={() => setPanel({ kind: "thread", roomId: room.id, rootId: message.id })}
              aria-label={t("chat.reply_in_thread")}
              title={t("chat.reply_in_thread")}
            >
              <IconMessageCircle size={16} />
            </button>
          )}
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded hover:bg-accent"
            onClick={() => void client.setSaved(room.id, message.id, !saved).catch(() => toast.error(t("chat.error")))}
            aria-label={saved ? t("chat.unsave") : t("chat.save")}
            title={saved ? t("chat.unsave") : t("chat.save")}
          >
            {saved ? <IconBookmarkFilled size={16} className="text-primary" /> : <IconBookmark size={16} />}
          </button>
          <span className="relative">
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded hover:bg-accent" onClick={() => setMenu((m) => !m)} aria-label={t("chat.more")} title={t("chat.more")}>
              <IconDots size={16} />
            </button>
            {menu && <MoreMenu message={message} room={room} client={client} onEdit={() => setEditing(true)} onReport={report} onClose={() => setMenu(false)} />}
          </span>
        </div>
      )}
    </div>
  );
}
