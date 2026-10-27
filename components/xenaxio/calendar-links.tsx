"use client";

// Step 48: calendars from Google, Outlook and others by link, both ways, in
// Settings → Calendars (xenaxio build only).
// - Subscriptions: the platform fetches the outside .ics feed and keeps a
//   calendar here in step with it (every 30 minutes; the browser can be closed).
// - Calendar link: a secret .ics link to one of the user's calendars, for
//   Google, Outlook or Apple Calendar to subscribe to.
// Bulwark's own subscription and URL import stay hidden: they need its server.
import { useCallback, useEffect, useId, useState } from "react";
import { useLocale } from "next-intl";
import { Globe, Link, RefreshCw, Trash2 } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Notice } from "@/components/xenaxio/ui";
import { type CalendarFeed, type CalendarSubscription, errorText, xenaxio } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];

export interface OwnCalendar {
  id: string;
  name: string;
}

const button =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 disabled:pointer-events-none";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50";

function useWhen() {
  const locale = useLocale();
  return useCallback(
    (iso: string) => new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
    [locale],
  );
}

/** The stored error ("feed_http_error:404", "events_failed:3") as a sentence. */
export function subscriptionError(t: (key: string, values?: Record<string, string | number>) => string, error: string): string {
  const cut = error.indexOf(":");
  const code = cut === -1 ? error : error.slice(0, cut);
  const detail = cut === -1 ? "" : error.slice(cut + 1);
  if (code === "events_failed") return t("calendar_links.events_failed", { count: detail });
  const text = t(`errors.${code}`);
  const known = text !== `errors.${code}` ? text : t("errors.internal");
  return detail && code === "feed_http_error" ? `${known} (HTTP ${detail})` : known;
}

function ColorChoice({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const t = useXT();
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("calendar_links.color")}>
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border-2 ${value === c ? "border-foreground" : "border-transparent"}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

function Subscriptions({ onChanged }: { onChanged: () => void }) {
  const t = useXT();
  const when = useWhen();
  const urlId = useId();
  const nameId = useId();
  const [list, setList] = useState<CalendarSubscription[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    xenaxio
      .calendarSubscriptions()
      .then((r) => setList(r.subscriptions))
      .catch(() => setLoadError(true));
  }, []);

  const replace = (sub: CalendarSubscription) => setList((l) => (l ?? []).map((s) => (s.id === sub.id ? sub : s)));

  const add = async () => {
    setBusy("add");
    setError(null);
    try {
      const { subscription } = await xenaxio.addCalendarSubscription({ url: url.trim(), name: name.trim(), color });
      setList((l) => [...(l ?? []), subscription]);
      setUrl("");
      setName("");
      onChanged();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          {t("calendar_links.subscribe_title")}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">{t("calendar_links.subscribe_intro")}</p>
      </div>

      {loadError && <Notice kind="error">{t("calendar_links.load_failed")}</Notice>}
      {list && list.length === 0 && <p className="text-sm text-muted-foreground">{t("calendar_links.none")}</p>}
      {list?.map((sub) => (
        <div key={sub.id} className="rounded-md border border-border px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-3">
            <span className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: sub.color ?? COLORS[0] }} />
            <div className="min-w-0 flex-1">
              {renaming?.id === sub.id ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(sub.id, async () => {
                      replace((await xenaxio.updateCalendarSubscription(sub.id, { name: renaming.name.trim() })).subscription);
                      setRenaming(null);
                      onChanged();
                    });
                  }}
                >
                  <Input value={renaming.name} onChange={(e) => setRenaming({ id: sub.id, name: e.target.value })} maxLength={100} aria-label={t("calendar_links.name")} autoFocus />
                  <button type="submit" className={button} disabled={!renaming.name.trim() || busy === sub.id}>
                    {t("calendar_links.save")}
                  </button>
                </form>
              ) : (
                <span className="block truncate text-sm font-medium">{sub.name}</span>
              )}
              <span className="block truncate text-xs text-muted-foreground">
                {sub.host} · {sub.refreshedAt ? t("calendar_links.refreshed", { time: when(sub.refreshedAt) }) : t("calendar_links.never")}
              </span>
            </div>
            <button
              type="button"
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
              title={t("calendar_links.refresh")}
              aria-label={t("calendar_links.refresh")}
              disabled={busy === sub.id}
              onClick={() =>
                void run(sub.id, async () => {
                  replace((await xenaxio.refreshCalendarSubscription(sub.id)).subscription);
                  onChanged();
                })
              }
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy === sub.id ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setRenaming(renaming?.id === sub.id ? null : { id: sub.id, name: sub.name })}
            >
              {t("calendar_links.rename")}
            </button>
            <button
              type="button"
              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
              title={t("calendar_links.remove")}
              aria-label={t("calendar_links.remove")}
              onClick={() => setRemoving(sub.id)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {sub.error && <Notice kind="error">{sub.paused ? t("calendar_links.paused") : t("calendar_links.error", { error: subscriptionError(t, sub.error) })}</Notice>}
          {removing === sub.id && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/5 px-3 py-2 text-sm">
              <span className="flex-1">{t("calendar_links.confirm_remove", { name: sub.name })}</span>
              <button
                type="button"
                className="rounded-md bg-destructive px-3 py-1 text-xs text-destructive-foreground"
                disabled={busy === sub.id}
                onClick={() =>
                  void run(sub.id, async () => {
                    await xenaxio.removeCalendarSubscription(sub.id);
                    setList((l) => (l ?? []).filter((s) => s.id !== sub.id));
                    setRemoving(null);
                    onChanged();
                  })
                }
              >
                {t("calendar_links.remove")}
              </button>
              <button type="button" className="rounded-md bg-muted px-3 py-1 text-xs" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      ))}

      <form
        className="space-y-3 rounded-md border border-dashed border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor={urlId} className="text-sm font-medium">
            {t("calendar_links.url")}
          </label>
          <Input id={urlId} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("calendar_links.url_placeholder")} inputMode="url" autoComplete="off" maxLength={2000} />
          <p className="text-xs text-muted-foreground">{t("calendar_links.how_google")}</p>
          <p className="text-xs text-muted-foreground">{t("calendar_links.how_outlook")}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t("calendar_links.name")}
          </label>
          <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("calendar_links.name_placeholder")} maxLength={100} />
        </div>
        <ColorChoice value={color} onChange={setColor} />
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" className={primary} disabled={!url.trim() || !name.trim() || busy === "add"}>
          {busy === "add" ? t("calendar_links.adding") : t("calendar_links.add")}
        </button>
      </form>
    </div>
  );
}

function Feeds({ calendars }: { calendars: OwnCalendar[] }) {
  const t = useXT();
  const when = useWhen();
  const selectId = useId();
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [calendarId, setCalendarId] = useState("");
  const [mode, setMode] = useState<"full" | "busy">("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "rotate" | "disable"; calendarId: string } | null>(null);

  useEffect(() => {
    xenaxio
      .calendarFeeds()
      .then((r) => setFeeds(r.feeds))
      .catch(() => setLoadError(true));
  }, []);

  const free = calendars.filter((c) => !feeds?.some((f) => f.calendarId === c.id));
  const chosen = calendarId && free.some((c) => c.id === calendarId) ? calendarId : (free[0]?.id ?? "");
  const nameOf = (id: string) => calendars.find((c) => c.id === id)?.name ?? id;
  const put = (feed: CalendarFeed) => setFeeds((l) => [...(l ?? []).filter((f) => f.calendarId !== feed.calendarId), feed]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Link className="w-4 h-4 text-muted-foreground" />
          {t("calendar_links.link_title")}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">{t("calendar_links.link_intro")}</p>
      </div>
      {loadError && <Notice kind="error">{t("calendar_links.load_failed")}</Notice>}

      {feeds?.map((feed) => (
        <div key={feed.calendarId} className="rounded-md border border-border px-3 py-2.5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 truncate text-sm font-medium">{nameOf(feed.calendarId)}</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={feed.mode}
              aria-label={t("calendar_links.mode")}
              disabled={busy}
              onChange={(e) => void run(async () => put((await xenaxio.setCalendarFeed(feed.calendarId, e.target.value as "full" | "busy")).feed))}
            >
              <option value="full">{t("calendar_links.mode_full")}</option>
              <option value="busy">{t("calendar_links.mode_busy")}</option>
            </select>
          </div>
          <div className="flex items-center gap-2 rounded bg-muted px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all text-xs">{feed.url}</code>
            <CopyButton value={feed.url} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">{feed.lastFetchedAt ? t("calendar_links.last_fetched", { time: when(feed.lastFetchedAt) }) : t("calendar_links.not_fetched")}</span>
            <button type="button" className={button} disabled={busy} onClick={() => setConfirm({ kind: "rotate", calendarId: feed.calendarId })}>
              {t("calendar_links.new_link")}
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => setConfirm({ kind: "disable", calendarId: feed.calendarId })}>
              {t("calendar_links.disable")}
            </button>
          </div>
          {confirm?.calendarId === feed.calendarId && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/5 px-3 py-2 text-sm">
              <span className="flex-1">{t(confirm.kind === "rotate" ? "calendar_links.confirm_new_link" : "calendar_links.confirm_disable")}</span>
              <button
                type="button"
                className="rounded-md bg-destructive px-3 py-1 text-xs text-destructive-foreground"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (confirm.kind === "rotate") put((await xenaxio.rotateCalendarFeed(feed.calendarId)).feed);
                    else {
                      await xenaxio.removeCalendarFeed(feed.calendarId);
                      setFeeds((l) => (l ?? []).filter((f) => f.calendarId !== feed.calendarId));
                    }
                    setConfirm(null);
                  })
                }
              >
                {t(confirm.kind === "rotate" ? "calendar_links.new_link" : "calendar_links.disable")}
              </button>
              <button type="button" className="rounded-md bg-muted px-3 py-1 text-xs" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      ))}

      {feeds && free.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3">
          <div className="space-y-1.5">
            <label htmlFor={selectId} className="block text-sm font-medium">
              {t("calendar_links.calendar")}
            </label>
            <select id={selectId} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={chosen} onChange={(e) => setCalendarId(e.target.value)}>
              {free.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <select className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={mode} aria-label={t("calendar_links.mode")} onChange={(e) => setMode(e.target.value as "full" | "busy")}>
            <option value="full">{t("calendar_links.mode_full")}</option>
            <option value="busy">{t("calendar_links.mode_busy")}</option>
          </select>
          <button type="button" className={primary} disabled={!chosen || busy} onClick={() => void run(async () => put((await xenaxio.setCalendarFeed(chosen, mode)).feed))}>
            {t("calendar_links.create_link")}
          </button>
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t("calendar_links.add_google")}</li>
        <li>{t("calendar_links.add_outlook")}</li>
      </ul>
      <Notice kind="info">{t("calendar_links.delay")}</Notice>
    </div>
  );
}

/**
 * Both blocks. `calendars`: the user's own calendars (shared ones and
 * subscriptions are filtered out here); `onChanged` reloads the calendar list.
 */
export function CalendarLinksSettings({ calendars, onChanged }: { calendars: OwnCalendar[]; onChanged: () => void }) {
  const t = useXT();
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!XENAXIO_BFF) return;
    xenaxio
      .calendarSubscriptions()
      .then((r) => setSubscribed(new Set(r.subscriptions.map((s) => s.calendarId))))
      .catch(() => undefined);
  }, [calendars.length]);
  if (!XENAXIO_BFF) return null;
  return (
    <section className="mt-8 space-y-6 border-t border-border pt-6" data-testid="xenaxio-calendar-links">
      <div>
        <h3 className="text-base font-semibold">{t("calendar_links.title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("calendar_links.intro")}</p>
      </div>
      <Subscriptions onChanged={onChanged} />
      <Feeds calendars={calendars.filter((c) => !subscribed.has(c.id))} />
    </section>
  );
}
