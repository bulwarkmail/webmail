"use client";

// Step 9: "Connect AI chats". For everyday users: how to add xenaxio to Claude
// as a connector (sign-in and consent, no token to copy) and the list of
// connected chats with a disconnect button. Personal tokens (M2, M4) for
// scripts and automations live in a collapsed "advanced" section.
// Step 51: the company's own address comes first; claude.ai takes each address
// once, so a second account connects under a label (…/mcp/<name>).
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
  const [data, setData] = useState<{ mcpUrl: string; sharedMcpUrl?: string; enabled: boolean; tokens: McpTokenInfo[] } | null>(null);
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

  const howto = ["mcp.howto_1", "mcp.howto_2", "mcp.howto_3", "mcp.howto_4"];
  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">{t("mcp.intro")}</p>
      <p className="text-sm text-muted-foreground">{t("mcp.chat_note")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!data.enabled && <Notice kind="info">{t("mcp.disabled")}</Notice>}

      {data.enabled && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="font-medium">{t("mcp.howto_title")}</h2>
          <ol className="space-y-3 text-sm">
            {howto.map((key, i) => (
              <li key={key} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p>{t(key)}</p>
                  {i === 1 && <Snippet label={t("mcp.url")} value={data.mcpUrl} />}
                </div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">{t("mcp.howto_other")}</p>
          {data.sharedMcpUrl && data.sharedMcpUrl !== data.mcpUrl && (
            <p className="text-xs text-muted-foreground break-all">
              {t("mcp.url_shared")}: <span className="font-mono">{data.sharedMcpUrl}</span>
            </p>
          )}
        </section>
      )}

      {data.enabled && (
        <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
          <h2 className="font-medium">{t("mcp.several_title")}</h2>
          <p>{t("mcp.several_text")}</p>
          <Snippet label={t("mcp.url")} value={`${data.mcpUrl}/${locale === "de" ? "konto-2" : "account-2"}`} />
          <p className="text-xs text-muted-foreground">{t("mcp.several_hint")}</p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">{t("mcp.connected")}</h2>
        {data.tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("mcp.none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {token.name}
                    {token.kind === "token" && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t("mcp.kind_token")} {token.hint}</span>}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("mcp.connected_since", { date: date(token.createdAt) })} · {t("mcp.expires", { date: date(token.expiresAt) })} ·{" "}
                    {token.lastUsedAt ? t("mcp.last_used", { date: date(token.lastUsedAt) }) : t("mcp.never_used")}
                  </span>
                  {token.address && <span className="block truncate font-mono text-xs text-muted-foreground">{t("mcp.address", { address: token.address })}</span>}
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

      <details className="group rounded-lg border border-border" open={created !== null}>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">{t("mcp.advanced")}</summary>
        <div className="space-y-4 border-t border-border p-4">
          <p className="text-sm text-muted-foreground">{t("mcp.advanced_intro")}</p>
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

        </div>
      </details>
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
