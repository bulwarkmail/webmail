"use client";

// Step 45: the company's own models — a check per model, the active one, the
// fallback to the AI by xenaxio and whether the server answers.
import { useState } from "react";
import { useLocale } from "next-intl";
import { Check, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CustomModelCheckResult } from "@/components/xenaxio/custom-model-check";
import { Notice } from "@/components/xenaxio/ui";
import { type CustomModel, errorText, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

function useWhen() {
  const locale = useLocale();
  return (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "");
}

export function CustomModelHealth({ health }: { health: CustomModel["health"] }) {
  const t = useXT();
  const when = useWhen();
  if (health.status === "down") {
    // The same words as the connection test, without its HTTP status.
    const reason = health.error ? t(`aiadmin.check_error_${health.error}`, { status: "" }).replace(/\s*\(\)/, "") : "";
    return <Notice kind="error">{t("aiadmin.health_down", { time: when(health.since), reason })}</Notice>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      {health.status === "ok" ? t("aiadmin.health_ok", { time: when(health.checkedAt) }) : t("aiadmin.health_unknown")} · {t("aiadmin.health_hint")}
    </p>
  );
}

export function CustomModelList({ custom, platformConfigured, onChanged }: { custom: CustomModel; platformConfigured: boolean; onChanged: () => Promise<void> }) {
  const t = useXT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await onChanged();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const shownModel = custom.models.find((m) => m.name === shown);

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">{t("aiadmin.models_title")}</h2>
      <CustomModelHealth health={custom.health} />

      <ul className="divide-y divide-border">
        {custom.models.map((m) => {
          const active = m.name === custom.model;
          const ok = m.check?.ok === true;
          return (
            <li key={m.name} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{m.name}</span>
              <button
                type="button"
                className={cn("inline-flex items-center gap-1 text-xs", ok ? "text-green-700 dark:text-green-400" : m.check ? "text-destructive" : "text-muted-foreground")}
                onClick={() => setShown(shown === m.name ? null : m.name)}
                disabled={!m.check}
                aria-expanded={shown === m.name}
              >
                {ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : m.check ? <X className="h-3.5 w-3.5" aria-hidden /> : null}
                {ok ? t("aiadmin.model_checked_ok") : m.check ? t("aiadmin.model_checked_failed") : t("aiadmin.model_unchecked")}
              </button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => act(`test:${m.name}`, async () => {
                await xenaxio.testCustomModel(m.name);
                setShown(m.name);
              })}>
                {busy === `test:${m.name}` ? t("aiadmin.model_testing") : t("aiadmin.model_test")}
              </Button>
              {active ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t("aiadmin.model_active")}</span>
              ) : (
                <Button type="button" size="sm" disabled={busy !== null || !ok} title={ok ? undefined : t("aiadmin.model_activate_untested")} onClick={() => act(`use:${m.name}`, () => xenaxio.setActiveCustomModel(m.name))}>
                  {t("aiadmin.model_activate")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {shownModel?.check && <CustomModelCheckResult check={shownModel.check} model={shownModel.name} />}

      <div className="space-y-1">
        <label className={cn("flex items-start gap-2 text-sm", !platformConfigured && "opacity-60")}>
          <input
            type="checkbox"
            className="mt-1"
            checked={custom.fallback}
            disabled={!platformConfigured || busy !== null}
            onChange={(e) => act("fallback", () => xenaxio.setCustomModelFallback(e.target.checked))}
          />
          <span>{t("aiadmin.fallback_label")}</span>
        </label>
        <p className="pl-6 text-xs text-muted-foreground">{platformConfigured ? t("aiadmin.fallback_hint") : t("aiadmin.fallback_unavailable")}</p>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
