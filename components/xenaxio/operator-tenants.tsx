"use client";

// Operator console (O1, O2): companies with usage, blocking, limits, and the
// monthly report for invoices.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice, Spinner, TextField } from "@/components/xenaxio/ui";
import { errorKey, type OperatorReport, type OperatorTenant, xenaxio } from "@/lib/xenaxio/api";
import { withBasePath } from "@/lib/browser-navigation";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / MB).toLocaleString()} MB`;
}

function Limits({ tenant, defaults, onSaved }: { tenant: OperatorTenant; defaults: { aiUserMonthlyTokens: number; aiTenantMonthlyTokens: number | null }; onSaved: () => Promise<void> }) {
  const t = useXT();
  const [form, setForm] = useState({
    maxMailboxes: String(tenant.maxMailboxes),
    mailboxQuotaMb: String(Math.round(tenant.mailboxQuotaBytes / MB)),
    aiUser: tenant.aiUserMonthlyTokens ? String(tenant.aiUserMonthlyTokens) : "",
    aiTenant: tenant.aiTenantMonthlyTokens ? String(tenant.aiTenantMonthlyTokens) : "",
  });
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      await xenaxio.operator.setTenantLimits(tenant.id, {
        maxMailboxes: Number(form.maxMailboxes),
        mailboxQuotaMb: Number(form.mailboxQuotaMb),
        aiUserMonthlyTokens: form.aiUser ? Number(form.aiUser) : null,
        aiTenantMonthlyTokens: form.aiTenant ? Number(form.aiTenant) : null,
      });
      setMessage({ kind: "success", text: t("operator.saved") });
      await onSaved();
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={save} className="grid gap-3 rounded-md bg-muted/50 p-3 sm:grid-cols-2" noValidate>
      <TextField label={t("operator.max_mailboxes")} type="number" min={1} value={form.maxMailboxes} onChange={set("maxMailboxes")} />
      <TextField label={t("operator.mailbox_quota")} type="number" min={100} value={form.mailboxQuotaMb} onChange={set("mailboxQuotaMb")} />
      <TextField
        label={t("operator.ai_user_limit")}
        type="number"
        min={1}
        hint={t("operator.default_hint", { value: defaults.aiUserMonthlyTokens.toLocaleString() })}
        value={form.aiUser}
        onChange={set("aiUser")}
      />
      <TextField
        label={t("operator.ai_tenant_limit")}
        type="number"
        min={1}
        hint={t("operator.default_hint", { value: defaults.aiTenantMonthlyTokens?.toLocaleString() ?? t("operator.default_auto") })}
        value={form.aiTenant}
        onChange={set("aiTenant")}
      />
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" size="sm">
          {t("operator.save")}
        </Button>
        {message && <span className={cn("text-sm", message.kind === "error" ? "text-destructive" : "text-muted-foreground")}>{message.text}</span>}
      </div>
    </form>
  );
}

export function OperatorTenants() {
  const t = useXT();
  const [data, setData] = useState<Awaited<ReturnType<typeof xenaxio.operator.tenants>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.operator.tenants());
    } catch (err) {
      setError(t(errorKey(err)));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggleBlock = async (tenant: OperatorTenant) => {
    const block = tenant.status !== "blocked";
    if (block && !window.confirm(t("operator.block_confirm", { name: tenant.name }))) return;
    setError(null);
    try {
      await xenaxio.operator.setTenantBlocked(tenant.id, block);
      await load();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("common.loading")} />;
  if (data.tenants.length === 0) return <p className="text-sm text-muted-foreground">{t("operator.tenants_empty")}</p>;

  return (
    <div className="space-y-3">
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {data.tenants.map((tenant) => (
          <li key={tenant.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {tenant.name}{" "}
                  <span
                    className={cn(
                      "ml-1 rounded-full px-2 py-0.5 text-xs",
                      tenant.status === "blocked" ? "bg-destructive/15 text-destructive" : tenant.status === "active" ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-muted",
                    )}
                  >
                    {t(`operator.status_${tenant.status}`)}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">{tenant.domain ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {t("operator.col_mailboxes")}: {tenant.mailboxes} / {tenant.maxMailboxes} · {t("operator.col_space")}: {formatBytes(tenant.usedBytes)} · {t("operator.col_ai")}:{" "}
                  {t("operator.ai_users", { count: tenant.aiUsers })}, {t("operator.tokens_month", { tokens: tenant.aiTokens.toLocaleString() })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setOpen(open === tenant.id ? null : tenant.id)} aria-expanded={open === tenant.id}>
                  {t("operator.limits")}
                </Button>
                <Button size="sm" variant="outline" className={tenant.status === "blocked" ? "" : "text-destructive"} onClick={() => toggleBlock(tenant)}>
                  {tenant.status === "blocked" ? t("operator.unblock") : t("operator.block")}
                </Button>
              </div>
            </div>
            {open === tenant.id && <Limits tenant={tenant} defaults={data.defaults} onSaved={load} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OperatorReportView() {
  const t = useXT();
  const locale = useLocale();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [report, setReport] = useState<OperatorReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    xenaxio.operator.report(month).then(setReport, (err) => setError(t(errorKey(err))));
  }, [month, t]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm font-medium">
          <span className="block">{t("operator.report_month")}</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
        </label>
        <a className="pb-2 text-sm text-primary hover:underline" href={withBasePath(`/api/operator/report.csv?month=${encodeURIComponent(month)}`)} download>
          {t("operator.download_csv")}
        </a>
      </div>
      <p className="text-xs text-muted-foreground">{t("operator.report_note")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {report && (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">{t("operator.col_company")}</th>
                <th className="px-3 py-2 font-medium text-right">{t("operator.col_mail")}</th>
                <th className="px-3 py-2 font-medium text-right">{t("operator.col_aiws")}</th>
                <th className="px-3 py-2 font-medium text-right">{t("operator.col_tokens")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.tenants.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    {r.name} <span className="text-xs text-muted-foreground">{r.domain}</span>
                  </td>
                  <td className="px-3 py-2 text-right">{r.mailUsers}</td>
                  <td className="px-3 py-2 text-right">{r.aiWorkspaceUsers}</td>
                  <td className="px-3 py-2 text-right">{r.aiTokens.toLocaleString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
