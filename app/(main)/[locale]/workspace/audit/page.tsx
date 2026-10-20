"use client";

// Audit log of AI and MCP use (C3, scenario 8): who, when, which tool, which
// objects. Filters by person, tool, source and dates; CSV export.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { auditQuery, type AuditEntry, type AuditFilter, errorKey, type WorkspaceUser, xenaxio } from "@/lib/xenaxio/api";
import { withBasePath } from "@/lib/browser-navigation";
import { useXT } from "@/lib/xenaxio/i18n";

const TOOLS = ["search_mail", "get_email", "get_thread", "create_draft", "search_contacts", "list_events", "find_free_time", "create_event", "llm:chat", "llm:summarize", "llm:reply"];

const select = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

function AuditView() {
  const t = useXT();
  const locale = useLocale();
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [applied, setApplied] = useState<AuditFilter>({});
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: AuditFilter, append: boolean) => {
      setError(null);
      try {
        const res = await xenaxio.audit(f);
        setEntries((prev) => (append && prev ? [...prev, ...res.entries] : res.entries));
        setNext(res.next);
      } catch (err) {
        setError(t(errorKey(err)));
      }
    },
    [t],
  );

  useEffect(() => {
    void xenaxio.users().then((r) => setUsers(r.users), () => setUsers([]));
    void load({}, false);
  }, [load]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied(filter);
    void load(filter, false);
  };

  const set = (k: keyof AuditFilter, v: string) => setFilter((f) => ({ ...f, [k]: v || undefined }));
  const time = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  const action = (a: string) => (a.startsWith("tool:") ? a.slice(5) : a);

  return (
    <div className="space-y-4">
      <form onSubmit={apply} className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
        <label className="space-y-1 text-xs font-medium sm:col-span-1">
          {t("audit.filter_person")}
          <select className={select} value={filter.userId ?? ""} onChange={(e) => set("userId", e.target.value)}>
            <option value="">{t("audit.all")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          {t("audit.filter_tool")}
          <select className={select} value={filter.tool ?? ""} onChange={(e) => set("tool", e.target.value)}>
            <option value="">{t("audit.all")}</option>
            {TOOLS.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          {t("audit.filter_source")}
          <select className={select} value={filter.source ?? ""} onChange={(e) => set("source", e.target.value)}>
            <option value="">{t("audit.all")}</option>
            <option value="panel">{t("audit.source_panel")}</option>
            <option value="mcp">{t("audit.source_mcp")}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium">
          {t("audit.filter_from")}
          <input type="date" className={select} value={filter.from ?? ""} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="space-y-1 text-xs font-medium">
          {t("audit.filter_to")}
          <input type="date" className={select} value={filter.to ?? ""} onChange={(e) => set("to", e.target.value)} />
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" size="sm">
            {t("audit.apply")}
          </Button>
          <a className="text-sm text-primary hover:underline" href={withBasePath(`/api/admin/audit.csv${auditQuery(applied)}`)} download>
            {t("audit.csv")}
          </a>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">{t("audit.note")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!entries ? (
        <Spinner label={t("common.loading")} />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("audit.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">{t("audit.col_time")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.col_person")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.col_source")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.col_action")}</th>
                <th className="px-3 py-2 font-medium">{t("audit.col_objects")}</th>
                <th className="px-3 py-2 font-medium text-right">{t("audit.col_tokens")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{time(e.createdAt)}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2">{e.userEmail ?? "–"}</td>
                  <td className="px-3 py-2 text-xs">{e.source === "mcp" ? `MCP${e.tokenName ? ` · ${e.tokenName}` : ""}` : t("audit.source_panel")}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {action(e.action)}
                    {e.status !== "ok" && <span className="ml-1 text-destructive">({t("audit.status_error")})</span>}
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={e.objectIds.join(", ")}>
                    {e.objectIds.join(", ") || "–"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">{e.inputTokens + e.outputTokens ? (e.inputTokens + e.outputTokens).toLocaleString(locale) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <Button variant="outline" size="sm" onClick={() => load({ ...applied, before: next }, true)}>
          {t("audit.more")}
        </Button>
      )}
    </div>
  );
}

export default function AuditPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("audit.title")} backHref="/workspace" requireAdmin>
      <AuditView />
    </WorkspaceShell>
  );
}
