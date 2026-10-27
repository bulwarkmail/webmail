"use client";

// Step 50: in "Verwaltung → KI" the company's admin sets how the assistant's
// scheduled tasks may be used: on or off, sending mail, how many per person,
// runs per day and how often at most, within the platform's ceilings.
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/xenaxio/ui";
import { errorText, type ScheduleSettings as Settings, type ScheduleSettingsInfo, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

/** "Höchstens alle …": 15 minutes up to a day. */
export const INTERVALS = [15, 30, 60, 120, 240, 1440] as const;

export function intervalLabel(minutes: number, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (minutes >= 1440) return t("aiadmin.schedules_interval_day");
  if (minutes >= 60) return t("aiadmin.schedules_interval_hours", { n: minutes / 60 });
  return t("aiadmin.schedules_interval_minutes", { n: minutes });
}

function Switch({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function NumberField({ id, label, hint, value, min, max, disabled, onChange }: { id: string; label: string; hint: string; value: number; min: number; max: number; disabled?: boolean; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className="w-28 rounded-md border border-input bg-background px-3 py-2 text-sm"
        min={min}
        max={max}
        step={1}
        required
        disabled={disabled}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function ScheduleSettings({ value, onSaved }: { value: ScheduleSettingsInfo; onSaved: () => Promise<void> }) {
  const t = useXT();
  const [form, setForm] = useState<Settings>({
    enabled: value.enabled,
    sendAllowed: value.sendAllowed,
    maxPerUser: value.maxPerUser,
    runsPerDay: value.runsPerDay,
    minIntervalMinutes: value.minIntervalMinutes,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const set = (change: Partial<Settings>) => setForm((f) => ({ ...f, ...change }));
  const caps = value.caps;
  const intervals = INTERVALS.filter((m) => m >= caps.minIntervalMinutes);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await xenaxio.saveScheduleSettings(form);
      setMessage({ kind: "success", text: res.paused > 0 ? t("aiadmin.schedules_saved_paused", { count: res.paused }) : t("aiadmin.saved") });
      await onSaved();
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-labelledby="ai-schedules-title">
      <div className="space-y-1">
        <h2 id="ai-schedules-title" className="font-medium">
          {t("aiadmin.schedules_title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("aiadmin.schedules_intro")}</p>
        <p className="text-xs text-muted-foreground">{t("aiadmin.schedules_count", { active: value.active, paused: value.paused })}</p>
      </div>
      <form onSubmit={save} className="space-y-4">
        <Switch id="ai-schedules-enabled" label={t("aiadmin.schedules_enabled")} hint={t("aiadmin.schedules_enabled_hint")} checked={form.enabled} disabled={busy} onChange={(enabled) => set({ enabled })} />
        <Switch
          id="ai-schedules-send"
          label={t("aiadmin.schedules_send")}
          hint={t("aiadmin.schedules_send_hint")}
          checked={form.sendAllowed}
          disabled={busy || !form.enabled}
          onChange={(sendAllowed) => set({ sendAllowed })}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            id="ai-schedules-max"
            label={t("aiadmin.schedules_max")}
            hint={t("aiadmin.schedules_range", { min: 0, max: caps.maxPerUser })}
            value={form.maxPerUser}
            min={0}
            max={caps.maxPerUser}
            disabled={busy || !form.enabled}
            onChange={(maxPerUser) => set({ maxPerUser })}
          />
          <NumberField
            id="ai-schedules-runs"
            label={t("aiadmin.schedules_runs")}
            hint={t("aiadmin.schedules_range", { min: 1, max: caps.runsPerDay })}
            value={form.runsPerDay}
            min={1}
            max={caps.runsPerDay}
            disabled={busy || !form.enabled}
            onChange={(runsPerDay) => set({ runsPerDay })}
          />
          <div className="space-y-1">
            <label htmlFor="ai-schedules-interval" className="block text-sm font-medium">
              {t("aiadmin.schedules_interval")}
            </label>
            <select
              id="ai-schedules-interval"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.minIntervalMinutes}
              disabled={busy || !form.enabled}
              onChange={(e) => set({ minIntervalMinutes: Number(e.target.value) })}
            >
              {intervals.map((m) => (
                <option key={m} value={m}>
                  {intervalLabel(m, t)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("aiadmin.schedules_interval_hint")}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("aiadmin.schedules_note")}</p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <Button type="submit" disabled={busy}>
          {t("aiadmin.schedules_save")}
        </Button>
      </form>
    </section>
  );
}
