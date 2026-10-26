// Step 43, part B: the chat's state for the interface. One ChatClient per
// page load (started when the chat page opens or the navigation needs the
// unread badge); components re-render when its version changes.
import { create } from "zustand";
import { apiFetch } from "@/lib/browser-navigation";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { type ChatStatus, chatStatus } from "./api";
import { ChatClient } from "./client";

/** A colleague as the platform knows them (name, e-mail, profile picture). */
export interface Colleague {
  address: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export type ChatView =
  | { kind: "room"; roomId: string }
  | { kind: "threads" }
  | { kind: "mentions" }
  | { kind: "saved" }
  | { kind: "browse" }
  | { kind: "search"; query: string }
  | { kind: "home" };

export type SidePanel = { kind: "thread"; roomId: string; rootId: string } | { kind: "members"; roomId: string } | { kind: "profile"; userId: string } | null;

interface ChatState {
  status: ChatStatus | null;
  statusError: boolean;
  client: ChatClient | null;
  version: number;
  colleagues: Map<string, Colleague>;
  view: ChatView;
  panel: SidePanel;
  /** Scroll to and highlight this message once (search results, links, saved). */
  focus: { roomId: string; eventId: string } | null;
  /** The message being edited (one at a time). */
  editing: string | null;
  loadStatus: (force?: boolean) => Promise<ChatStatus | null>;
  connect: () => Promise<void>;
  disconnect: () => void;
  setView: (view: ChatView) => void;
  setPanel: (panel: SidePanel) => void;
  setFocus: (focus: ChatState["focus"]) => void;
  setEditing: (id: string | null) => void;
}

const STATUS_TTL_MS = 5 * 60_000;
let statusLoadedAt = 0;
let statusPromise: Promise<ChatStatus | null> | null = null;

async function loadColleagues(): Promise<Map<string, Colleague>> {
  try {
    const res = await apiFetch("/api/chat/people", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return new Map();
    const data = (await res.json()) as { people?: Colleague[] };
    return new Map((data.people ?? []).map((p) => [p.address, p]));
  } catch {
    return new Map();
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  status: null,
  statusError: false,
  client: null,
  version: 0,
  colleagues: new Map(),
  view: { kind: "home" },
  panel: null,
  focus: null,
  editing: null,

  loadStatus: async (force = false) => {
    if (!XENAXIO_BFF) return null;
    if (!force && get().status && Date.now() - statusLoadedAt < STATUS_TTL_MS) return get().status;
    if (statusPromise) return statusPromise;
    statusPromise = chatStatus()
      .then((status) => {
        statusLoadedAt = Date.now();
        set({ status, statusError: false });
        return status;
      })
      .catch(() => {
        set({ statusError: true });
        return null;
      })
      .finally(() => {
        statusPromise = null;
      });
    return statusPromise;
  },

  connect: async () => {
    if (get().client) return;
    const status = await get().loadStatus();
    if (!status?.enabled) return;
    const client = new ChatClient();
    client.subscribe(() => set((s) => ({ version: s.version + 1 })));
    set({ client });
    void loadColleagues().then((colleagues) => set({ colleagues }));
    try {
      await client.start();
    } catch {
      set({ client: null, statusError: true });
    }
  },

  disconnect: () => {
    get().client?.stop();
    set({ client: null });
  },

  setView: (view) => set({ view }),
  setPanel: (panel) => set({ panel }),
  setFocus: (focus) => set({ focus }),
  setEditing: (editing) => set({ editing }),
}));

/** Reads from the chat client and re-renders when it changes. */
export function useChat<T>(select: (client: ChatClient) => T, fallback: T): T {
  const client = useChatStore((s) => s.client);
  useChatStore((s) => s.version);
  return client ? select(client) : fallback;
}
