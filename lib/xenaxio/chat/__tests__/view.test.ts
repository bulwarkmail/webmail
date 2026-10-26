import { describe, expect, it } from "vitest";
import type { Message, Room } from "../client";
import { parseSearch, sidebarSections, suggestionAt, threadsOf, timelineRows } from "../view";

const msg = (id: string, sender: string, ts: number, extra: Partial<Message> = {}): Message => ({
  id,
  roomId: "!r",
  sender,
  ts,
  type: "m.room.message",
  content: { body: id },
  edited: false,
  redacted: false,
  reactions: {},
  ...extra,
});
const DAY = 24 * 3600_000;
const base = new Date(2026, 9, 26, 9, 0).getTime();

describe("timeline layout", () => {
  it("groups by author, divides days and marks the first unread message", () => {
    const rows = timelineRows(
      [msg("a", "@anna", base), msg("b", "@anna", base + 60_000), msg("c", "@max", base + 120_000), msg("d", "@anna", base + DAY), msg("e", "@anna", base + DAY + 10 * 60_000)],
      { readUpTo: "c", me: "@max", hasUnread: true },
    );
    expect(rows.map((r) => (r.kind === "message" ? `${r.message.id}${r.continued ? "+" : ""}` : r.kind))).toEqual(["day", "a", "b+", "c", "day", "new", "d", "e"]);
  });

  it("shows no new line without unread messages", () => {
    const rows = timelineRows([msg("a", "@anna", base), msg("b", "@tom", base + 1000)], { readUpTo: "a", me: "@max", hasUnread: false });
    expect(rows.some((r) => r.kind === "new")).toBe(false);
  });
});

describe("sidebar and search", () => {
  const room = (id: string, extra: Partial<Room>): Room => ({ id, kind: "channel", membership: "join", tags: {}, lastTs: 0, archived: false, ...extra }) as Room;

  it("orders channels by name and direct messages by activity", () => {
    const s = sidebarSections(
      [room("1", { name: "vertrieb" }), room("2", { name: "Alle" }), room("3", { kind: "dm", lastTs: 5 }), room("4", { kind: "dm", lastTs: 9 }), room("5", { name: "fav", tags: { "m.favourite": {} } }), room("6", { kind: "space" }), room("7", { membership: "invite" })],
      (r) => r.name ?? r.id,
    );
    expect(s.channels.map((r) => r.id)).toEqual(["2", "1"]);
    expect(s.direct.map((r) => r.id)).toEqual(["4", "3"]);
    expect(s.starred.map((r) => r.id)).toEqual(["5"]);
    expect(s.invites.map((r) => r.id)).toEqual(["7"]);
  });

  it("reads Slack's search filters", () => {
    expect(parseSearch("Angebot in:#vertrieb from:@anna")).toEqual({ term: "Angebot", inChannel: "vertrieb", from: "anna" });
    expect(parseSearch("nur text")).toEqual({ term: "nur text", inChannel: null, from: null });
  });

  it("finds the mention or channel being typed", () => {
    expect(suggestionAt("Hallo @an", 9)).toEqual({ trigger: "@", query: "an", start: 6 });
    expect(suggestionAt("siehe #ver", 10)).toEqual({ trigger: "#", query: "ver", start: 6 });
    expect(suggestionAt("mail@acme.de", 12)).toBeNull();
  });

  it("lists my threads and those with news", () => {
    const r = room("1", { timeline: [msg("root", "@anna", base, { thread: { count: 2, latestTs: base + 5, participants: ["@max"] } }), msg("other", "@anna", base, { thread: { count: 1, latestTs: base + 9, participants: ["@tom"] } })], threads: new Map(), threadUnread: new Map() });
    expect(threadsOf([r], "@max").map((t) => t.root.id)).toEqual(["root"]);
    // Unread replies in a thread I do not follow do not count, a mention does.
    r.threadUnread.set("other", { notifications: 3, highlights: 0 });
    expect(threadsOf([r], "@max").map((t) => t.root.id)).toEqual(["root"]);
    r.threadUnread.set("other", { notifications: 3, highlights: 1 });
    expect(threadsOf([r], "@max").map((t) => [t.root.id, t.unread])).toEqual([["other", 1], ["root", 0]]);
  });
});
