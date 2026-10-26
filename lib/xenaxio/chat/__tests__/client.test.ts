import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; path: string; body?: unknown }[] = [];
let answer: (method: string, path: string, body?: unknown) => unknown = () => ({});
vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>();
  return {
    ...real,
    mx: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return answer(method, path, body);
    }),
  };
});

import { ChatClient, type RawEvent, type SyncResponse } from "../client";

const ROOM = "!alle:acme.de";
let n = 0;
function ev(partial: Partial<RawEvent> & { type: string }): RawEvent {
  n += 1;
  return { event_id: `$e${n}`, sender: "@anna:acme.de", origin_server_ts: 1000 + n, content: {}, ...partial };
}
function sync(events: RawEvent[], extra: Partial<SyncResponse["rooms"]> = {}, more: Record<string, unknown> = {}): SyncResponse {
  return { next_batch: `s${n}`, rooms: { join: { [ROOM]: { timeline: { events, prev_batch: "p0" }, ...more } }, ...extra } };
}
const text = (body: string, extra: Record<string, unknown> = {}) => ev({ type: "m.room.message", content: { msgtype: "m.text", body, ...extra } });

describe("chat client", () => {
  let c: ChatClient;
  beforeEach(() => {
    calls.length = 0;
    answer = () => ({});
    c = new ChatClient();
    c.userId = "@max:acme.de";
  });

  it("builds a channel from the sync: name, members, timeline, unread", () => {
    c.processSync(
      {
        next_batch: "s1",
        rooms: {
          join: {
            [ROOM]: {
              state: { events: [ev({ type: "m.room.name", state_key: "", content: { name: "Alle" } }), ev({ type: "m.room.member", state_key: "@anna:acme.de", content: { membership: "join", displayname: "Anna Schmidt" } })] },
              timeline: { events: [text("Hallo"), ev({ type: "m.room.power_levels", state_key: "", content: { users: { "@max:acme.de": 100 } } })], prev_batch: "p1", limited: true },
              unread_notifications: { notification_count: 2, highlight_count: 1 },
            },
          },
        },
      },
      true,
    );
    const room = c.rooms.get(ROOM)!;
    expect(c.roomName(room)).toBe("Alle");
    expect(c.displayName("@anna:acme.de", room)).toBe("Anna Schmidt");
    expect(room.timeline.map((m) => m.content.body)).toEqual(["Hallo"]);
    expect(room.notifications).toBe(2);
    expect(room.highlights).toBe(1);
    expect(room.prevBatch).toBe("p1");
    expect(c.can(room, "state")).toBe(true);
    expect(c.totals()).toEqual({ notifications: 2, highlights: 1 });
  });

  it("keeps thread replies out of the channel and counts them on the first message", () => {
    const root = text("Wer übernimmt Schulz?");
    c.processSync(sync([root]), true);
    const reply = (body: string, sender = "@tom:acme.de") => ev({ type: "m.room.message", sender, content: { msgtype: "m.text", body, "m.relates_to": { rel_type: "m.thread", event_id: root.event_id } } });
    c.processSync(sync([reply("Ich"), reply("Ich helfe", "@eva:acme.de")]), false);
    const room = c.rooms.get(ROOM)!;
    expect(room.timeline).toHaveLength(1);
    expect(room.threads.get(root.event_id!)!.map((m) => m.content.body)).toEqual(["Ich", "Ich helfe"]);
    expect(room.timeline[0]!.thread).toMatchObject({ count: 2, participants: ["@tom:acme.de", "@eva:acme.de"] });
  });

  it("applies edits, reactions and deletions — also when they arrive first", () => {
    const m = text("Angebot ist raus");
    const edit = ev({ type: "m.room.message", content: { body: "* Angebot v2", "m.new_content": { msgtype: "m.text", body: "Angebot v2" }, "m.relates_to": { rel_type: "m.replace", event_id: m.event_id } } });
    const thumbs = ev({ type: "m.reaction", sender: "@tom:acme.de", content: { "m.relates_to": { rel_type: "m.annotation", event_id: m.event_id, key: "👍" } } });
    const room = () => c.rooms.get(ROOM)!;
    c.processSync(sync([]), true);
    // Backward pagination brings newer relations before the message itself.
    c.addEvent(room(), thumbs, "backward");
    c.addEvent(room(), edit, "backward");
    c.addEvent(room(), m, "backward");
    const msg = room().byId.get(m.event_id!)!;
    expect(msg.content.body).toBe("Angebot v2");
    expect(msg.edited).toBe(true);
    expect(msg.reactions).toEqual({ "👍": ["@tom:acme.de"] });
    // Someone else cannot edit it.
    c.processSync(sync([ev({ type: "m.room.message", sender: "@eva:acme.de", content: { "m.new_content": { body: "gehackt" }, "m.relates_to": { rel_type: "m.replace", event_id: m.event_id } } })]), false);
    expect(msg.content.body).toBe("Angebot v2");
    // The reaction is taken back, then the message deleted.
    c.processSync(sync([ev({ type: "m.room.redaction", sender: "@tom:acme.de", redacts: thumbs.event_id, content: {} })]), false);
    expect(msg.reactions).toEqual({});
    c.processSync(sync([ev({ type: "m.room.redaction", content: { redacts: m.event_id } })]), false);
    expect(msg.redacted).toBe(true);
    expect(msg.content).toEqual({});
  });

  it("shows my message at once and swaps in the real one", async () => {
    c.processSync(sync([]), true);
    answer = (method) => (method === "PUT" ? { event_id: "$real" } : {});
    await c.send(ROOM, { msgtype: "m.text", body: "Hallo" });
    const room = c.rooms.get(ROOM)!;
    expect(room.timeline).toHaveLength(1);
    expect(room.timeline[0]).toMatchObject({ id: "$real", content: { body: "Hallo" } });
    expect(room.timeline[0]!.status).toBeUndefined();
    // The same event from the sync does not show twice.
    c.processSync(sync([{ event_id: "$real", type: "m.room.message", sender: "@max:acme.de", origin_server_ts: 5, content: { msgtype: "m.text", body: "Hallo" } }]), false);
    expect(room.timeline).toHaveLength(1);
  });

  it("marks a failed message, retries it and replies in threads", async () => {
    c.processSync(sync([text("Frage")]), true);
    const room = c.rooms.get(ROOM)!;
    const root = room.timeline[0]!.id;
    answer = () => {
      throw new Error("offline");
    };
    await c.send(ROOM, { msgtype: "m.text", body: "Antwort" }, { threadRoot: root });
    const local = room.threads.get(root)![0]!;
    expect(local.status).toBe("failed");
    expect(calls.at(-1)!.body).toMatchObject({ "m.relates_to": { rel_type: "m.thread", event_id: root } });
    answer = () => ({ event_id: "$ok" });
    await c.retry(ROOM, local.id);
    expect(local).toMatchObject({ id: "$ok" });
    expect(local.status).toBeUndefined();
  });

  it("reads my receipts, typing and direct conversations", () => {
    c.processSync(
      {
        next_batch: "s9",
        account_data: { events: [{ type: "m.direct", sender: "", content: { "@anna:acme.de": ["!dm:acme.de"] } }] },
        rooms: {
          join: {
            "!dm:acme.de": {
              state: { events: [ev({ type: "m.room.member", state_key: "@anna:acme.de", content: { membership: "join", displayname: "Anna" } })] },
              timeline: { events: [text("Hi")] },
              ephemeral: { events: [{ type: "m.typing", sender: "", content: { user_ids: ["@anna:acme.de", "@max:acme.de"] } }, { type: "m.receipt", sender: "", content: { $x: { "m.read": { "@max:acme.de": { ts: 1 } } } } }] },
            },
          },
        },
      },
      true,
    );
    const dm = c.rooms.get("!dm:acme.de")!;
    expect(dm.kind).toBe("dm");
    expect(c.roomName(dm)).toBe("Anna");
    expect(dm.typing).toEqual(["@anna:acme.de"]);
    expect(dm.readUpTo).toBe("$x");
  });

  it("hides the service account's setup and accepts colleagues' invitations", () => {
    c.processSync(
      sync([
        ev({ type: "m.room.member", sender: "@xenaxio:acme.de", state_key: "@xenaxio:acme.de", content: { membership: "join" } }),
        ev({ type: "m.room.name", sender: "@xenaxio:acme.de", state_key: "", content: { name: "Alle" } }),
        ev({ type: "m.room.member", state_key: "@anna:acme.de", content: { membership: "join", displayname: "Anna" } }),
      ]),
      true,
    );
    expect(c.rooms.get(ROOM)!.timeline.map((m) => m.type)).toEqual(["m.room.member"]);
    expect(c.rooms.get(ROOM)!.name).toBe("Alle");
    c.processSync(
      {
        next_batch: "s2",
        rooms: {
          invite: {
            "!dm:acme.de": { invite_state: { events: [{ type: "m.room.member", state_key: "@max:acme.de", sender: "@anna:acme.de", content: { membership: "invite", is_direct: true } }] } },
            "!ext:other.de": { invite_state: { events: [{ type: "m.room.member", state_key: "@max:acme.de", sender: "@eve:other.de", content: { membership: "invite" } }] } },
          },
        },
      },
      false,
    );
    expect(calls.filter((x) => x.path.includes("/join/")).map((x) => x.path)).toEqual(["/_matrix/client/v3/join/!dm%3Aacme.de"]);
  });

  it("marks read once and only what is unread", async () => {
    c.processSync(sync([text("a")], {}, { unread_notifications: { notification_count: 1, highlight_count: 0 } }), true);
    await c.markRead(ROOM);
    await c.markRead(ROOM);
    expect(calls.filter((x) => x.path.includes("read_markers"))).toHaveLength(1);
    expect(c.rooms.get(ROOM)!.notifications).toBe(0);
  });
});
