// Step 43, part B: how the chat lays out messages, independent of React:
// grouping by author, day dividers, the "new" line, sidebar order, search
// filters. Kept pure so it is tested without a browser.
import type { Message, Room } from "./client";

/** Messages of one author within five minutes form a group (Slack shows the name once). */
const GROUP_GAP_MS = 5 * 60_000;

export type TimelineRow =
  | { kind: "day"; key: string; day: number }
  | { kind: "new"; key: string }
  | { kind: "message"; key: string; message: Message; continued: boolean };

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Rows of a timeline: day dividers, the line above the first unread message, messages. */
export function timelineRows(messages: Message[], opts: { readUpTo?: string | null; me?: string; hasUnread?: boolean } = {}): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let lastDay = -1;
  let prev: Message | null = null;
  // The "new" line goes after my read receipt, before the first message of someone else.
  let readIndex = opts.readUpTo ? messages.findIndex((m) => m.id === opts.readUpTo) : -1;
  if (!opts.hasUnread) readIndex = messages.length;
  let newPlaced = false;
  messages.forEach((m, i) => {
    const day = dayStart(m.ts);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, day });
      lastDay = day;
      prev = null;
    }
    if (!newPlaced && readIndex >= 0 && i > readIndex && m.sender !== opts.me && m.type === "m.room.message") {
      rows.push({ kind: "new", key: "new" });
      newPlaced = true;
      prev = null;
    }
    const continued = !!prev && prev.sender === m.sender && prev.type === "m.room.message" && m.type === "m.room.message" && m.ts - prev.ts < GROUP_GAP_MS && !prev.thread;
    rows.push({ kind: "message", key: m.txnId ? `t-${m.txnId}` : m.id, message: m, continued });
    prev = m;
  });
  return rows;
}

/** Sidebar order: favourites, then channels by name; direct messages by last activity. */
export function sidebarSections(rooms: Room[], roomName: (r: Room) => string): { invites: Room[]; starred: Room[]; channels: Room[]; direct: Room[] } {
  const joined = rooms.filter((r) => r.membership === "join" && r.kind !== "space");
  const starred = joined.filter((r) => r.tags["m.favourite"]).sort((a, b) => roomName(a).localeCompare(roomName(b)));
  const rest = joined.filter((r) => !r.tags["m.favourite"]);
  return {
    invites: rooms.filter((r) => r.membership === "invite"),
    starred,
    channels: rest.filter((r) => r.kind === "channel" && !r.archived).sort((a, b) => roomName(a).localeCompare(roomName(b), undefined, { sensitivity: "base" })),
    direct: rest.filter((r) => r.kind === "dm").sort((a, b) => b.lastTs - a.lastTs),
  };
}

/** "Angebot in:#vertrieb from:@anna" → words and filters (Slack's search syntax). */
export function parseSearch(query: string): { term: string; inChannel: string | null; from: string | null } {
  let inChannel: string | null = null;
  let from: string | null = null;
  const term = query
    .replace(/\bin:#?(\S+)/i, (_, c: string) => {
      inChannel = c;
      return "";
    })
    .replace(/\bfrom:@?(\S+)/i, (_, f: string) => {
      from = f;
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { term, inChannel, from };
}

/** Messages of the loaded timelines that mention me, newest first (the "Erwähnungen" view). */
export function mentionsOf(rooms: Room[], isMention: (m: Message) => boolean): Message[] {
  const out: Message[] = [];
  for (const room of rooms) {
    if (room.membership !== "join") continue;
    for (const m of room.byId.values()) if (!m.redacted && m.type === "m.room.message" && isMention(m)) out.push(m);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Threads I took part in or that have news for me, newest activity first (the "Threads" view). */
export function threadsOf(rooms: Room[], me: string): { room: Room; root: Message; unread: number }[] {
  const out: { room: Room; root: Message; unread: number }[] = [];
  for (const room of rooms) {
    if (room.membership !== "join") continue;
    for (const root of room.timeline) {
      if (!root.thread?.count) continue;
      const replies = room.threads.get(root.id) ?? [];
      const counts = room.threadUnread.get(root.id);
      const mine = root.sender === me || root.thread.participants.includes(me) || replies.some((r) => r.sender === me);
      // Like Slack: threads I follow (started or answered) and those I am mentioned in.
      if (!mine && !counts?.highlights) continue;
      out.push({ room, root, unread: mine ? (counts?.notifications ?? 0) : (counts?.highlights ?? 0) });
    }
  }
  return out.sort((a, b) => (b.root.thread?.latestTs ?? 0) - (a.root.thread?.latestTs ?? 0));
}

/** The text of the composer's "@" or "#" suggestion at the cursor, if one is being typed. */
export function suggestionAt(text: string, cursor: number): { trigger: "@" | "#"; query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)([@#])([^\s@#]{0,30})$/.exec(before);
  if (!m) return null;
  return { trigger: m[2] as "@" | "#", query: m[3] as string, start: cursor - (m[3] as string).length - 1 };
}
