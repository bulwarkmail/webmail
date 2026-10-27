"use client";

// Step 49: "Geplante Aufgaben" on the page "Assistent": what the assistant
// does on its own, when it runs next and how the last run went; pause,
// resume, run now and delete. New ones are set up in the assistant panel.
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { CalendarClock, Mail, Send } from "@/components/icons";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { formatRun } from "@/components/xenaxio/schedule-card";
import { intervalLabel } from "@/components/xenaxio/schedule-settings";
import { errorText, type ScheduleInfo, type ScheduleList as ScheduleData, xenaxio } from "@/lib/xenaxio/api";
import { ASSISTANT_OPEN_PARAM } from "@/lib/xenaxio/assistant";
import { useXT } from "@/lib/xenaxio/i18n";

/** The line under a task: next run, why it is paused, or that it is over. */
export function scheduleState(s: ScheduleInfo, t: (key: string, values?: Record<string, string | number>) => string, locale: string): string {
  if (s.status === "ended") return t("schedules.ended");
  if (s.status === "paused") return s.pausedReason ? t(`schedules.paused_${s.pausedReason}`) : t("schedules.paused");
  return s.nextRun ? t("schedules.next", { when: formatRun(s.nextRun, locale) }) : "";
}

export function ScheduleList() {
  const t = useXT();
  const locale = useLocale();
  const router = useRouter();
  const [data, setData] = useState<ScheduleData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.schedules());
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, change: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await change();
      if (done) setNotice(done);
      await load();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const openChat = (conversationId: string) => router.push(`/mail/?${ASSISTANT_OPEN_PARAM}=${encodeURIComponent(conversationId)}`);

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("common.loading")} />;

  return (
    <section className="space-y-3" aria-labelledby="schedules-title">
      <div className="space-y-1">
        <h2 id="schedules-title" className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4 text-primary" />
          {t("schedules.title", { count: data.schedules.filter((s) => s.status === "active").length, max: data.maxSchedules })}
        </h2>
        <p className="text-sm text-muted-foreground">{t("schedules.intro", { max: data.maxRunsPerDay, every: intervalLabel(data.minIntervalMinutes ?? 60, t) })}</p>
      </div>
      {/* Step 50: what the company's admin set. */}
      {data.enabled === false && <Notice kind="info">{t("schedules.company_off")}</Notice>}
      {data.enabled !== false && data.sendAllowed === false && data.schedules.some((s) => s.maySend) && <Notice kind="info">{t("schedules.company_no_send")}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {data.schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("schedules.none")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.schedules.map((s) => (
            <li key={s.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{s.title}</p>
                  <p className="break-words text-sm text-muted-foreground">{s.instruction}</p>
                </div>
                <span className={s.status === "active" ? "rounded bg-primary/10 px-2 py-0.5 text-xs text-primary" : "rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"}>
                  {t(`schedules.status_${s.status}`)}
                </span>
              </div>
              <p className="text-sm">{s.when}</p>
              <p className="text-xs text-muted-foreground">
                {scheduleState(s, t, locale)}
                {s.lastRun ? ` · ${t(`schedules.last_${s.lastStatus ?? "done"}`, { when: formatRun(s.lastRun, locale) })}` : ""}
              </p>
              {(s.emailCopy || s.maySend) && (
                <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {s.emailCopy && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" />
                      {t("schedules.email_copy")}
                    </span>
                  )}
                  {s.maySend && (
                    <span className="flex items-center gap-1 break-all">
                      <Send className="h-3.5 w-3.5 shrink-0" />
                      {t("schedules.may_send", { to: s.sendTo.join(", ") })}
                    </span>
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {s.status === "active" && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run(s.id, () => xenaxio.pauseSchedule(s.id))}>
                    {t("schedules.pause")}
                  </Button>
                )}
                {s.status !== "active" && data.enabled !== false && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run(s.id, () => xenaxio.resumeSchedule(s.id))}>
                    {t("schedules.resume")}
                  </Button>
                )}
                {data.enabled !== false && (
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run(s.id, () => xenaxio.runSchedule(s.id), t("schedules.run_started"))}>
                    {t("schedules.run_now")}
                  </Button>
                )}
                {s.conversationId && (
                  <Button size="sm" variant="outline" onClick={() => openChat(s.conversationId as string)}>
                    {t("schedules.open_chat")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm(t("schedules.delete_confirm", { title: s.title }))) void run(s.id, () => xenaxio.deleteSchedule(s.id));
                  }}
                >
                  {t("schedules.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("schedules.how")}</p>
    </section>
  );
}
