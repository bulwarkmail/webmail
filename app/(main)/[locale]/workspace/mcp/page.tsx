"use client";

// M2, M4: personal MCP tokens. The user names a token, copies it once together
// with a ready command for Claude Code or a JSON config, and can revoke it.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Notice, Spinner, TextField } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, type McpTokenInfo, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { claudeCodeCommand, jsonConfig } from "@/lib/xenaxio/mcp";

const LIFETIMES = [30, 90, 365] as const;

function Snippet({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted px-3 py-2 text-xs">{value}</pre>
    </div>
  );
}

function Tokens() {
  const t = useXT();
  const locale = useLocale();
  const [data, setData] = useState<{ mcpUrl: string; enabled: boolean; tokens: McpTokenInfo[] } | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState<(typeof LIFETIMES)[number]>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.mcpTokens());
    } catch (err) {
      setError(t(errorKey(err)));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await xenaxio.createMcpToken(name.trim(), days);
      setCreated({ token: res.token, mcpUrl: res.mcpUrl });
      setName("");
      await load();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: McpTokenInfo) => {
    if (!window.confirm(t("mcp.revoke_confirm", { name: token.name }))) return;
    setError(null);
    try {
      await xenaxio.revokeMcpToken(token.id);
      await load();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("common.loading")} />;

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">{t("mcp.intro")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!data.enabled && <Notice kind="info">{t("mcp.disabled")}</Notice>}

      {created ? (
        <section className="space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <Notice kind="success">{t("mcp.created")}</Notice>
          <Snippet label={t("mcp.claude_code")} value={claudeCodeCommand(created.mcpUrl, created.token)} />
          <Snippet label={t("mcp.json")} value={jsonConfig(created.mcpUrl, created.token)} />
          <Snippet label={t("mcp.token")} value={created.token} />
          <Snippet label={t("mcp.url")} value={created.mcpUrl} />
          <Button onClick={() => setCreated(null)}>{t("mcp.done")}</Button>
        </section>
      ) : (
        data.enabled && (
          <form onSubmit={create} className="space-y-4 rounded-lg border border-border p-4" noValidate>
            <h2 className="font-medium">{t("mcp.new")}</h2>
            <TextField label={t("mcp.name")} hint={t("mcp.name_hint")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("mcp.lifetime")}</legend>
              <div className="flex flex-wrap gap-2">
                {LIFETIMES.map((d) => (
                  <Button key={d} type="button" size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)} aria-pressed={d === days}>
                    {t("mcp.days", { days: d })}
                  </Button>
                ))}
              </div>
            </fieldset>
            <Button type="submit" disabled={busy || !name.trim()}>
              {t("mcp.create")}
            </Button>
          </form>
        )
      )}

      <section className="space-y-2">
        <h2 className="font-medium">{t("mcp.list")}</h2>
        {data.tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("mcp.none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {token.name} <span className="font-mono text-xs text-muted-foreground">{token.hint}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("mcp.expires", { date: date(token.expiresAt) })} · {token.lastUsedAt ? t("mcp.last_used", { date: date(token.lastUsedAt) }) : t("mcp.never_used")}
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => revoke(token)}>
                  {t("mcp.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("mcp.audit_note")}</p>
      </section>
    </div>
  );
}

export default function McpPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("mcp.title")} backHref="/workspace">
      <Tokens />
    </WorkspaceShell>
  );
}
