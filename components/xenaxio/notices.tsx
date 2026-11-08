"use client";

// xenaxio step 124, part C: the platform's notifications (a task assigned, a
// mention, a comment, a due date) in Bulwark's bell — a section above the
// browser's own entries, and the unread count added to the bell's badge. The
// platform keeps them (90 days); the list is read every minute while the page
// is visible, and when the page comes back.
import { useEffect } from "react";
import { create } from "zustand";
import { useFormatter } from "next-intl";
import { CheckCheck } from "@/components/icons";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { type Notice, noticeHref, notificationsApi } from "@/lib/xenaxio/notifications";

interface NoticesState {
  notices: Notice[];
  unread: number;
  loaded: boolean;
  refresh: () => Promise<void>;
  markRead: (ids?: string[]) => Promise<void>;
}

export const useXenaxioNotices = create<NoticesState>((set, get) => ({
  notices: [],
  unread: 0,
  loaded: false,
  refresh: async () => {
    try {
      const r = await notificationsApi.list();
      set({ notices: r.notices, unread: r.unread, loaded: true });
    } catch {
      // Signed out or offline: keep what is shown.
    }
  },
  markRead: async (ids) => {
    const now = get().notices;
    set({ notices: now.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)), unread: ids ? Math.max(0, get().unread - now.filter((n) => ids.includes(n.id) && !n.read).length) : 0 });
    try {
      const r = await notificationsApi.read(ids);
      set({ unread: r.unread });
    } catch {
      void get().refresh();
    }
  },
}));

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => document.visibilityState === "visible" && void useXenaxioNotices.getState().refresh();

/** The unread count for the bell's badge; the first user starts reading the list every minute. */
export function useXenaxioNoticeCount(): number {
  const unread = useXenaxioNotices((s) => s.unread);
  useEffect(() => {
    if (!XENAXIO_BFF) return;
    watchers += 1;
    if (watchers === 1) {
      void useXenaxioNotices.getState().refresh();
      timer = setInterval(() => document.visibilityState === "visible" && void useXenaxioNotices.getState().refresh(), 60_000);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);
  return XENAXIO_BFF ? unread : 0;
}

/** The section in the bell's panel (nothing outside Xenaxio). */
export function XenaxioNotices({ onClose }: { onClose: () => void }) {
  return XENAXIO_BFF ? <Section onClose={onClose} /> : null;
}

function Section({ onClose }: { onClose: () => void }) {
  const t = useXT();
  const format = useFormatter();
  const router = useRouter();
  const { notices, unread, loaded, markRead, refresh } = useXenaxioNotices();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!loaded) return null;

  const open = (n: Notice) => {
    if (!n.read) void markRead([n.id]);
    onClose();
    router.push(noticeHref(n.link));
  };

  return (
    <section aria-label={t("notices.title")} className="border-b border-border">
      <div className="flex items-center gap-1 px-3 pt-2">
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Xenaxio</h3>
        {unread > 0 && (
          <button type="button" onClick={() => void markRead()} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <CheckCheck className="h-3.5 w-3.5" />
            {t("notices.read_all")}
          </button>
        )}
      </div>
      {notices.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("notices.none")}</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {notices.slice(0, 30).map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => open(n)} className={cn("flex w-full gap-2 px-3 py-2 text-left hover:bg-muted", !n.read && "bg-primary/5")}>
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted-foreground">
                    {n.kind === "task_due" ? t("notices.kind.task_due") : `${n.actor?.name ?? "—"} ${t(`notices.kind.${n.kind}`)}`} ·{" "}
                    {format.relativeTime(new Date(n.createdAt), new Date())}
                  </span>
                  <span className={cn("block truncate text-sm", !n.read && "font-medium")}>{n.title}</span>
                  {n.body && <span className="block truncate text-xs text-muted-foreground">{n.body}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
