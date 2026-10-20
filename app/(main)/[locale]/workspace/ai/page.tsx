"use client";

// AI settings of the company (C2, I8, scenario 8): switch AI on or off for
// everyone, pick the model, see this month's usage per person against the limits.
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { type AiAdmin, errorKey, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

function Bar({ share, warnShare }: { share: number; warnShare: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div
        className={cn("h-full rounded-full", share >= 1 ? "bg-destructive" : share >= warnShare ? "bg-amber-500" : "bg-primary")}
        style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
      />
    </div>
  );
}

function AiSettings() {
  const t = useXT();
  const locale = useLocale();
  const [data, setData] = useState<AiAdmin | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.aiAdmin());
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (c: { enabled?: boolean; model?: string }) => {
    setBusy(true);
    setMessage(null);
    try {
      await xenaxio.setAiAdmin(c);
      setMessage({ kind: "success", text: t("aiadmin.saved") });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return message ? <Notice kind="error">{message.text}</Notice> : <Spinner label={t("common.loading")} />;

  const n = (v: number) => v.toLocaleString(locale);
  const month = new Date(`${data.month}-01T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric" });
  const companyShare = data.tenantTokens / data.limits.tenantMonthlyTokens;

  return (
    <div className="max-w-2xl space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {!data.configured && <Notice kind="info">{t("aiadmin.not_configured")}</Notice>}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("aiadmin.company")}</h2>
        <p className="text-sm text-muted-foreground">{data.companyEnabled ? t("aiadmin.company_on") : t("aiadmin.company_off")}</p>
        <Button variant={data.companyEnabled ? "outline" : "default"} disabled={busy} onClick={() => change({ enabled: !data.companyEnabled })}>
          {data.companyEnabled ? t("aiadmin.switch_off") : t("aiadmin.switch_on")}
        </Button>
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <label htmlFor="ai-model" className="font-medium">
          {t("aiadmin.model")}
        </label>
        <p className="text-sm text-muted-foreground">{t("aiadmin.model_hint")}</p>
        <select
          id="ai-model"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={data.model}
          disabled={busy}
          onChange={(e) => change({ model: e.target.value })}
        >
          {data.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("aiadmin.usage", { month })}</h2>
        <div className="space-y-1">
          <p className="text-sm">{t("aiadmin.usage_company", { used: n(data.tenantTokens), limit: n(data.limits.tenantMonthlyTokens) })}</p>
          <Bar share={companyShare} warnShare={data.warnShare} />
          {companyShare >= 1 ? (
            <p className="text-xs text-destructive">{t("aiadmin.limit_reached")}</p>
          ) : companyShare >= data.warnShare ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t("aiadmin.limit_warning")}</p>
          ) : null}
        </div>
        <ul className="divide-y divide-border">
          {data.users
            .filter((u) => u.aiEnabled || u.tokens > 0)
            .map((u) => {
              const share = u.tokens / data.limits.userMonthlyTokens;
              return (
                <li key={u.id} className="space-y-1 py-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{u.displayName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("aiadmin.usage_person", { used: n(u.tokens), limit: n(data.limits.userMonthlyTokens) })}
                    </span>
                  </div>
                  <Bar share={share} warnShare={data.warnShare} />
                </li>
              );
            })}
        </ul>
        <p className="text-xs text-muted-foreground">{t("aiadmin.limit_note")}</p>
      </section>
    </div>
  );
}

export default function AiAdminPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("aiadmin.title")} backHref="/workspace" requireAdmin>
      <AiSettings />
    </WorkspaceShell>
  );
}
