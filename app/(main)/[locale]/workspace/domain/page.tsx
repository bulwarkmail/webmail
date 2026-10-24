"use client";

// DNS page (T3, C4): the records to publish, each with a check result.
// While the domain is not connected it also says where DNS is edited, warns
// when mail of the domain lives at another provider today, and explains the
// steps (owner's request, 22.10.2026: "no instructions at all").
// Step 28: a company can have several domains; the list is on top, the
// selected domain's records below.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Plus, RefreshCw } from "@/components/icons";
import { CatchAllSettings } from "@/components/xenaxio/catch-all";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Notice } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { type DnsReport, type DnsState, type DomainInfo, type WorkspaceDomain, errorKey, errorText, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<DnsState | "unchecked", string> = {
  ok: "bg-green-600/15 text-green-700 dark:text-green-400",
  missing: "bg-destructive/15 text-destructive",
  mismatch: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  error: "bg-muted text-muted-foreground",
  unchecked: "bg-muted text-muted-foreground",
};

/** Step 28: the company's domains, adding and removing one. */
function DomainsView() {
  const t = useXT();
  const [domains, setDomains] = useState<WorkspaceDomain[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await xenaxio.domains();
    setDomains(res.domains);
    setLimit(res.limits.maxDomains);
    setSelected((prev) => (prev && res.domains.some((d) => d.id === prev) ? prev : (res.domains[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    load().catch((err) => setNotice({ kind: "error", text: t(errorKey(err)) }));
  }, [load, t]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const domain = await xenaxio.addDomain(name.trim().toLowerCase());
      setName("");
      setNotice({ kind: "success", text: t("domain.added", { domain: domain.name }) });
      await load();
      setSelected(domain.id);
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (domain: WorkspaceDomain) => {
    if (!window.confirm(t("domain.delete_confirm", { domain: domain.name }))) return;
    setBusy(true);
    setNotice(null);
    try {
      await xenaxio.deleteDomain(domain.id);
      setNotice({ kind: "success", text: t("domain.deleted", { domain: domain.name }) });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  if (!domains) return notice ? <Notice kind="error">{notice.text}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  const current = domains.find((d) => d.id === selected) ?? domains[0];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">{t("domain.list_title")}</h2>
          <span className="text-xs text-muted-foreground">{t("domain.count", { count: domains.length, limit })}</span>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {domains.map((d) => {
            const active = d.status === "active";
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2 p-3">
                <button
                  type="button"
                  className={cn("min-w-0 flex-1 text-left", d.id === current?.id && "font-medium")}
                  aria-current={d.id === current?.id ? "true" : undefined}
                  onClick={() => setSelected(d.id)}
                >
                  <span className="block truncate">{d.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("domain.mailboxes", { count: d.mailboxes })}
                    {d.primary && ` · ${t("domain.primary")}`}
                  </span>
                </button>
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", active ? STATE_STYLE.ok : STATE_STYLE.mismatch)}>
                  {active ? t("domain.status_active") : t("domain.status_pending")}
                </span>
                {d.id !== current?.id && (
                  <Button size="sm" variant="outline" onClick={() => setSelected(d.id)}>
                    {t("domain.show")}
                  </Button>
                )}
                {!d.primary && (
                  <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void remove(d)}>
                    {t("domain.delete")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {domains.length < limit ? (
          <form onSubmit={add} className="flex flex-wrap items-center gap-2" noValidate>
            <Input
              aria-label={t("domain.add_label")}
              placeholder={t("domain.add_placeholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              className="min-w-0 flex-1 sm:max-w-xs"
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              <Plus className="w-4 h-4 mr-1.5" />
              {t("domain.add")}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">{t("domain.limit_reached", { limit })}</p>
        )}
        {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      </section>

      {/* Keyed by id: another domain starts with its own state. */}
      {current && <DomainView key={current.id} domainId={current.id} onStatus={() => void load().catch(() => undefined)} />}
    </div>
  );
}

function DomainView({ domainId, onStatus }: { domainId: string; onStatus: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const [info, setInfo] = useState<DomainInfo | null>(null);
  const [report, setReport] = useState<DnsReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    xenaxio
      .domain(domainId)
      .then((d) => {
        setInfo(d);
        setReport(d.lastCheck);
      })
      .catch((err) => setError(t(errorKey(err))));
  }, [t, domainId]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await xenaxio.checkDomain(domainId);
      setReport(res.report);
      setInfo((prev) => (prev ? { ...prev, domain: res.domain } : prev));
      // The list shows the status too.
      if (res.domain.status !== info?.domain.status) onStatus();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setChecking(false);
    }
  }, [t, domainId, onStatus, info?.domain.status]);

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

      <CatchAllSettings domain={info.domain.name} domainId={domainId} />
    </div>
  );
}

export default function DomainPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("domain.title")} backHref="/workspace" requireAdmin>
      <DomainsView />
    </WorkspaceShell>
  );
}
