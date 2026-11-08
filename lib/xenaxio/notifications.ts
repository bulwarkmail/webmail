// xenaxio step 124, part C: the bell — the person's notifications in Xenaxio
// (projects first) — and their choice which notifications they get. The platform
// keeps both; push comes through the chat's Web Push subscription.
import { apiFetch } from "@/lib/browser-navigation";
import { XenaxioApiError } from "@/lib/xenaxio/api";

// Whole paths, so the Lite build check (scripts/lite/lib.mjs) sees each one.
const NOTIFICATIONS = "/api/notifications";
const PREFS = "/api/me/notify-prefs";

export const NOTICE_KINDS = ["task_assigned", "task_mention", "task_comment", "task_done", "task_due_changed", "task_due"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type NoticeLevel = "push" | "bell" | "off";

export interface Notice {
  id: string;
  kind: string;
  actor: { id: string; name: string } | null;
  title: string;
  body: string | null;
  /** Path in the client, e.g. /projects/?id=…&task=… */
  link: string;
  objectId: string | null;
  taskId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotifyPrefs {
  kinds: Record<NoticeKind, NoticeLevel>;
  assignEmail: boolean;
  dueEmail: boolean;
  calendarTasks: boolean;
}

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", "x-xenaxio-csrf": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new XenaxioApiError(0, "network");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new XenaxioApiError(res.status, typeof data.error === "string" ? data.error : "internal");
  return data as T;
}

export const notificationsApi = {
  list: (unread = false) => call<{ notices: Notice[]; unread: number }>("GET", `${NOTIFICATIONS}${unread ? "?unread=1" : ""}`),
  count: () => call<{ unread: number }>("GET", `${NOTIFICATIONS}/count`),
  read: (ids?: string[]) => call<{ marked: number; unread: number }>("POST", `${NOTIFICATIONS}/read`, ids ? { ids } : {}),
  prefs: () => call<NotifyPrefs>("GET", PREFS),
  savePrefs: (change: Partial<Omit<NotifyPrefs, "kinds">> & { kinds?: Partial<Record<NoticeKind, NoticeLevel>> }) => call<NotifyPrefs>("PUT", PREFS, change),
};

/** The notice's link as a client path without the trailing slash before the query (static export). */
export function noticeHref(link: string): string {
  return link.replace(/\/\?/, "?");
}
