"use client";

// Step 43, part C: notifications of the chat — the "turn them on" banner, the
// settings (this device, pause, quiet hours, keywords, e-mail) and the bridge
// that lets a click on a chat notification open the chat from any window.
import { IconBell, IconBellOff, IconX } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { ChatClient } from "@/lib/xenaxio/chat/client";
import {
  chatPushState,
  disableChatPush,
  enableChatPush,
  isPaused,
  loadChatSettings,
  minutesToTime,
  pauseUntil,
  resumeChatPush,
  saveChatSettings,
  timeToMinutes,
  type ChatNotifySettings,
  type ChatPushState,
} from "@/lib/xenaxio/chat/push";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { Modal } from "./dialogs";

const BANNER_KEY = "xenaxio-chat-push-banner-dismissed";

interface NotifyStore {
  push: ChatPushState | null;
  settings: ChatNotifySettings | null;
  load: (locale: string) => Promise<void>;
  setPush: (push: ChatPushState) => void;
  save: (settings: ChatNotifySettings) => Promise<void>;
}

export const useChatNotify = create<NotifyStore>((set) => ({
  push: null,
  settings: null,
  load: async (locale) => {
    await resumeChatPush(locale).catch(() => undefined);
    const [push, settings] = await Promise.all([chatPushState().catch(() => "off" as const), loadChatSettings().catch(() => null)]);
    set({ push, settings });
  },
  setPush: (push) => set({ push }),
  save: async (settings) => set({ settings: await saveChatSettings(settings) }),
}));

function bannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Loads the state once the chat is open and keeps a device that had push on subscribed. */
export function useChatNotifyLoader(ready: boolean) {
  const locale = useLocale();
  const load = useChatNotify((s) => s.load);
  useEffect(() => {
    if (ready) void load(locale);
  }, [ready, locale, load]);
}

/** Asked once, explained, in the chat itself (like Slack), never by itself on page load. */
export function PushBanner() {
  const t = useXT();
  const locale = useLocale();
  const push = useChatNotify((s) => s.push);
  const setPush = useChatNotify((s) => s.setPush);
  const [hidden, setHidden] = useState(bannerDismissed);
  const [busy, setBusy] = useState(false);
  if (hidden || push !== "off" || typeof Notification === "undefined" || Notification.permission !== "default") return null;
  const dismiss = () => {
    try {
      localStorage.setItem(BANNER_KEY, "1");
    } catch {
      // Shown again next time.
    }
    setHidden(true);
  };
  return (
    <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
      <IconBell size={18} className="shrink-0 text-primary" />
      <span className="min-w-0 flex-1">{t("chat.push_banner")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setPush(await enableChatPush(locale));
          } catch {
            toast.error(t("chat.push_failed"));
          } finally {
            setBusy(false);
          }
        }}
        className="h-8 shrink-0 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50"
      >
        {t("chat.push_enable")}
      </button>
      <button type="button" onClick={dismiss} aria-label={t("chat.close")} className="shrink-0 rounded p-1 hover:bg-accent">
        <IconX size={16} />
      </button>
    </div>
  );
}

/** The bell in the sidebar header: shows a pause and opens the settings. */
export function NotifyButton({ onOpen }: { onOpen: () => void }) {
  const t = useXT();
  const settings = useChatNotify((s) => s.settings);
  const [, tick] = useState(0);
  // The pause ends by itself: look again every minute.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const paused = isPaused(settings);
  return (
    <button type="button" onClick={onOpen} className="rounded-md p-1.5 hover:bg-accent" title={paused ? t("chat.notify_paused") : t("chat.notify_button")} aria-label={t("chat.notify_button")}>
      {paused ? <IconBellOff size={18} className="text-red-500" /> : <IconBell size={18} />}
    </button>
  );
}

const DAYS = [1, 2, 3, 4, 5, 6, 7];

export function NotifySettingsDialog({ client, onClose }: { client: ChatClient; onClose: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const push = useChatNotify((s) => s.push);
  const setPush = useChatNotify((s) => s.setPush);
  const settings = useChatNotify((s) => s.settings);
  const save = useChatNotify((s) => s.save);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState(minutesToTime(settings?.dndFrom ?? null) || "18:00");
  const [to, setTo] = useState(minutesToTime(settings?.dndTo ?? null) || "08:00");
  const [days, setDays] = useState<number[]>(settings?.dndDays.length ? settings.dndDays : [1, 2, 3, 4, 5, 6, 7]);
  const [scheduled, setScheduled] = useState(settings?.dndFrom != null && settings?.dndTo != null);
  const [keywords, setKeywords] = useState<string | null>(null);

  useEffect(() => {
    void client
      .keywords()
      .then((list) => setKeywords(list.join(", ")))
      .catch(() => setKeywords(""));
  }, [client]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      toast.error(t("chat.error"));
    } finally {
      setBusy(false);
    }
  };

  const base: ChatNotifySettings = settings ?? { dndUntil: null, dndFrom: null, dndTo: null, dndDays: [], emailDigest: true };
  const paused = isPaused(settings);
  const until = paused && settings?.dndUntil ? new Date(settings.dndUntil) : null;

  const saveAll = () =>
    run(async () => {
      const f = timeToMinutes(from);
      const tt = timeToMinutes(to);
      if (scheduled && (f === null || tt === null || f === tt || days.length === 0)) {
        toast.error(t("chat.notify_schedule_invalid"));
        return;
      }
      await save({ ...base, dndFrom: scheduled ? f : null, dndTo: scheduled ? tt : null, dndDays: scheduled ? days : [] });
      if (keywords !== null) {
        const words = [...new Set(keywords.split(/[,\n]/).map((w) => w.trim()).filter((w) => w.length > 0 && w.length <= 60))].slice(0, 30);
        await client.setKeywords(words);
      }
      onClose();
    });

  return (
    <Modal title={t("chat.notify_title")} onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="font-semibold">{t("chat.notify_device")}</h3>
          {push === "unsupported" && <p className="mt-1 text-muted-foreground">{t("chat.push_unsupported")}</p>}
          {push === "denied" && <p className="mt-1 text-muted-foreground">{t("chat.push_denied")}</p>}
          {(push === "on" || push === "off" || push === null) && (
            <label className="mt-1 flex items-center gap-2">
              <input
                type="checkbox"
                checked={push === "on"}
                disabled={busy || push === null}
                onChange={(e) => run(async () => setPush(e.target.checked ? await enableChatPush(locale) : await disableChatPush()))}
              />
              <span>{t("chat.notify_device_on")}</span>
            </label>
          )}
        </section>

        <section>
          <h3 className="font-semibold">{t("chat.notify_pause")}</h3>
          {until ? (
            <div className="mt-1 flex items-center gap-3">
              <span>{t("chat.notify_paused_until", { time: until.toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}</span>
              <button type="button" disabled={busy} onClick={() => run(() => save({ ...base, dndUntil: null }))} className="h-8 rounded-md border border-border px-3 hover:bg-accent">
                {t("chat.notify_resume")}
              </button>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap gap-2">
              {(["30m", "1h", "2h", "tomorrow"] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => save({ ...base, dndUntil: pauseUntil(choice).toISOString() }))}
                  className="h-8 rounded-md border border-border px-3 hover:bg-accent"
                >
                  {t(`chat.notify_pause_${choice}`)}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
            {t("chat.notify_schedule")}
          </label>
          {scheduled && (
            <div className="mt-2 space-y-2 pl-6">
              <div className="flex items-center gap-2">
                <span>{t("chat.notify_from")}</span>
                <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2" />
                <span>{t("chat.notify_to")}</span>
                <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2" />
              </div>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(d)}
                    onClick={() => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort()))}
                    className={days.includes(d) ? "h-8 w-10 rounded-md bg-primary text-primary-foreground" : "h-8 w-10 rounded-md border border-border hover:bg-accent"}
                  >
                    {t(`chat.day_${d}`)}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("chat.notify_schedule_hint")}</p>
            </div>
          )}
        </section>

        <section>
          <h3 className="font-semibold">{t("chat.notify_keywords")}</h3>
          <input
            value={keywords ?? ""}
            disabled={keywords === null}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder={t("chat.notify_keywords_hint")}
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </section>

        <section>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={base.emailDigest} disabled={busy} onChange={(e) => run(() => save({ ...base, emailDigest: e.target.checked }))} />
            <span>{t("chat.notify_email")}</span>
          </label>
        </section>

        <div className="flex justify-end">
          <button type="button" disabled={busy} onClick={() => void saveAll()} className="h-9 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50">
            {t("chat.notify_save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * In every window of the app: a click on a chat notification while mail or
 * files is open goes to the chat (the chat's worker cannot navigate windows
 * that Bulwark's worker controls).
 */
export function ChatPushBridge() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { kind?: string; url?: string } | null;
      if (data?.kind !== "xenaxio-chat-navigate" || typeof data.url !== "string") return;
      // Only a path of this site.
      if (!data.url.startsWith("/") || data.url.startsWith("//")) return;
      window.location.assign(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.startMessages();
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  return null;
}
