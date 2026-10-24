"use client";

// DNS page (T3, C4): the records to publish, each with a check result.
// While the domain is not connected it also says where DNS is edited, warns
// when mail of the domain lives at another provider today, and explains the
// steps (owner's request, 22.10.2026: "no instructions at all").
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "@/components/icons";
import { CatchAllSettings } from "@/components/xenaxio/catch-all";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Notice } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { type DnsReport, type DnsState, type DomainInfo, errorKey, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<DnsState | "unchecked", string> = {
  ok: "bg-green-600/15 text-green-700 dark:text-green-400",
  missing: "bg-destructive/15 text-destructive",
  mismatch: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  error: "bg-muted text-muted-foreground",
  unchecked: "bg-muted text-muted-foreground",
};

function DomainView() {
  const t = useXT();
  const locale = useLocale();
  const [info, setInfo] = useState<DomainInfo | null>(null);
  const [report, setReport] = useState<DnsReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    xenaxio
      .domain()
      .then((d) => {
        setInfo(d);
        setReport(d.lastCheck);
      })
      .catch((err) => setError(t(errorKey(err))));
  }, [t]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await xenaxio.checkDomain();
      setReport(res.report);
      setInfo((prev) => (prev ? { ...prev, domain: res.domain } : prev));
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setChecking(false);
    }
  }, [t]);

  if (!info) return error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

  const active = info.domain.status === "active";
  const resultFor = (name: string, purpose: string, value: string) =>
    report?.records.find((r) => r.name === name && r.purpose === purpose && r.expected === value);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-lg font-medium">{info.domain.name}</span>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", active ? STATE_STYLE.ok : STATE_STYLE.mismatch)}>
          {active ? t("domain.status_active") : t("domain.status_pending")}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{t("domain.intro", { domain: info.domain.name })}</p>

      {!active && info.context?.otherMail && (
        <div role="alert" className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">{t("domain.other_mail_title", { domain: info.domain.name })}</p>
            <p>{t("domain.other_mail", { domain: info.domain.name, mx: info.context.currentMx.join(", ") })}</p>
          </div>
        </div>
      )}

      {!active && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="font-medium">{t("domain.howto_title", { domain: info.domain.name })}</h2>
          <ol className="space-y-3 text-sm">
            {[
              <>
                <p>
                  {info.context?.provider
                    ? t("domain.provider", { domain: info.domain.name, provider: info.context.provider })
                    : t("domain.provider_unknown", { domain: info.domain.name })}
                </p>
                {info.context && info.context.nameservers.length > 0 && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground break-all">{t("domain.nameservers", { list: info.context.nameservers.join(", ") })}</p>
                )}
              </>,
              <>
                <p>{t("domain.howto_2")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("domain.name_hint", { domain: info.domain.name })}</p>
              </>,
              <p key="3">{t("domain.howto_3")}</p>,
            ].map((content, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1 pt-0.5">{content}</div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={check} disabled={checking}>
          <RefreshCw className={cn("w-4 h-4 mr-1.5", checking && "animate-spin")} />
          {checking ? t("domain.checking") : t("domain.check")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {report ? t("domain.last_checked", { time: new Date(report.checkedAt).toLocaleString(locale) }) : t("domain.never_checked")}
        </span>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {report && <Notice kind={report.mailReady ? "success" : "info"}>{report.mailReady ? t("domain.mail_ready") : t("domain.mail_not_ready")}</Notice>}

      <ul className="space-y-3">
        {info.records.map((record) => {
          const result = resultFor(record.name, record.purpose, record.value);
          const state = result?.state ?? "unchecked";
          return (
            <li key={`${record.purpose}-${record.name}`} className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{record.type}</span>
                  <span className="text-sm font-medium">{t(`domain.purpose_${record.purpose}`)}</span>
                </div>
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATE_STYLE[state])}>{t(`domain.state_${state}`)}</span>
              </div>
              <div className="grid gap-1.5 text-sm">
                <div className="flex items-start gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">{t("domain.col_name")}</span>
                  <code className="flex-1 min-w-0 break-all font-mono text-xs">{record.name}</code>
                  <CopyButton value={record.name} />
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">{t("domain.col_value")}</span>
                  <code className="flex-1 min-w-0 break-all font-mono text-xs">
                    {record.value}
                    {record.priority !== undefined && <span className="ml-2 text-muted-foreground">({t("domain.priority", { priority: record.priority })})</span>}
                  </code>
                  <CopyButton value={record.value} />
                </div>
              </div>
              {result && result.state !== "ok" && result.found.length > 0 && (
                <p className="text-xs text-muted-foreground break-all">{t("domain.found", { value: result.found.join(", ") })}</p>
              )}
            </li>
          );
        })}
      </ul>

      <CatchAllSettings domain={info.domain.name} />
    </div>
  );
}

export default function DomainPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("domain.title")} backHref="/workspace" requireAdmin>
      <DomainView />
    </WorkspaceShell>
  );
}
