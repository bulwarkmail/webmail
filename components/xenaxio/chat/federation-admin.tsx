"use client";

// Step 43, part E: the admin decides whether the company's chat talks to other
// companies (Matrix federation) and sees how to make it findable: a discovery
// file on the website, or DNS records (where the platform can get the certificate).
import { IconCheck, IconCopy, IconWorld } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/xenaxio/ui";
import { apiFetch } from "@/lib/browser-navigation";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";

export type FederationMode = "off" | "xenaxio" | "all";

export interface FederationSettings {
  mode: FederationMode;
  allow: string[];
  deny: string[];
  serverName: string;
  target: string;
  reachable: boolean;
  method: "well-known" | "dns" | null;
  error: string | null;
  checkedAt: string | null;
  setup: {
    wellKnown: { url: string; body: unknown; redirectTo: string };
    dns: { srv: { name: string; target: string; port: number }; cname: { name: string; target: string } | null } | null;
  };
}

const headers = { Accept: "application/json", "Content-Type": "application/json", "x-xenaxio-csrf": "1" };

async function call(method: string, path: string, body?: unknown): Promise<FederationSettings> {
  const res = await apiFetch(path, { method, credentials: "same-origin", headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = (await res.json().catch(() => ({}))) as FederationSettings & { error?: string; details?: { server?: string } };
  if (!res.ok) throw Object.assign(new Error(String(data.error ?? res.status)), { server: data.details?.server });
  return data;
}

const toList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function Copy({ text }: { text: string }) {
  const t = useXT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error(t("chat.error"));
        }
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
      aria-label={t("chat.hooks_copy")}
      title={t("chat.hooks_copy")}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-1 rounded bg-muted px-2 py-1">
      <code className="min-w-0 flex-1 break-all text-xs">{children}</code>
      <Copy text={children} />
    </div>
  );
}

export function FederationAdmin() {
  const t = useXT();
  const [data, setData] = useState<FederationSettings | null>(null);
  const [mode, setMode] = useState<FederationMode>("xenaxio");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((d: FederationSettings) => {
    setData(d);
    setMode(d.mode);
    setAllow(d.allow.join("\n"));
    setDeny(d.deny.join("\n"));
  }, []);
  useEffect(() => {
    call("GET", "/api/admin/chat/federation").then(apply, () => setError(t("chat.error")));
  }, [apply, t]);

  const run = async (job: () => Promise<FederationSettings>, ok?: string) => {
    setBusy(true);
    setError(null);
    try {
      apply(await job());
      if (ok) toast.success(ok);
    } catch (err) {
      const e = err as Error & { server?: string };
      setError(e.message === "invalid_server" ? t("chatadmin.fed_invalid_server", { server: e.server ?? "" }) : t("chat.error"));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : null;
  const wk = data.setup.wellKnown;
  const dns = data.setup.dns;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <IconWorld size={18} />
        <h2 className="text-base font-semibold">{t("chatadmin.fed_title")}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t("chatadmin.fed_intro", { domain: data.serverName })}</p>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="space-y-1.5 text-sm">
        {(["off", "xenaxio", "all"] as const).map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input type="radio" name="federation" checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
            <span>
              <span className="font-medium">{t(`chatadmin.fed_mode_${m}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`chatadmin.fed_mode_${m}_hint`)}</span>
            </span>
          </label>
        ))}
      </div>

      {mode !== "off" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {mode === "xenaxio" && (
            <label className="block text-sm">
              <span className="font-medium">{t("chatadmin.fed_allow")}</span>
              <textarea value={allow} onChange={(e) => setAllow(e.target.value)} rows={3} placeholder="steuerberater.de" className="mt-1 w-full rounded-md border border-input bg-transparent p-2 text-sm" />
            </label>
          )}
          <label className="block text-sm">
            <span className="font-medium">{t("chatadmin.fed_deny")}</span>
            <textarea value={deny} onChange={(e) => setDeny(e.target.value)} rows={3} placeholder="spam.example" className="mt-1 w-full rounded-md border border-input bg-transparent p-2 text-sm" />
          </label>
        </div>
      )}
      <Button disabled={busy} onClick={() => void run(() => call("PUT", "/api/admin/chat/federation", { mode, allow: toList(allow), deny: toList(deny) }), t("chatadmin.fed_saved"))}>
        {t("chat.notify_save")}
      </Button>

      {mode !== "off" && (
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={data.reachable ? "text-sm font-medium text-emerald-600" : "text-sm font-medium text-amber-600"}>
              {data.reachable ? t(data.method === "dns" ? "chatadmin.fed_ok_dns" : "chatadmin.fed_ok_wellknown") : t("chatadmin.fed_not_reachable")}
            </span>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => call("POST", "/api/admin/chat/federation/check"))}>
              {t("chatadmin.fed_check")}
            </Button>
          </div>
          {!data.reachable && data.error && <p className="break-all text-xs text-muted-foreground">{t("chatadmin.fed_last_error", { error: data.error })}</p>}
          {!data.reachable && (
            <>
              <p className="text-sm">{t("chatadmin.fed_setup_intro")}</p>
              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="text-sm font-medium">{t("chatadmin.fed_way_file")}</div>
                <p className="text-xs text-muted-foreground">{t("chatadmin.fed_way_file_text")}</p>
                <Code>{wk.url}</Code>
                <Code>{JSON.stringify(wk.body)}</Code>
                <p className="text-xs text-muted-foreground">{t("chatadmin.fed_way_redirect")}</p>
                <Code>{wk.redirectTo}</Code>
              </div>
              {dns && (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="text-sm font-medium">{t("chatadmin.fed_way_dns")}</div>
                  <p className="text-xs text-muted-foreground">{t("chatadmin.fed_way_dns_text")}</p>
                  <Code>{`${dns.srv.name}. SRV 10 0 ${dns.srv.port} ${dns.srv.target}.`}</Code>
                  {dns.cname ? <Code>{`${dns.cname.name}. CNAME ${dns.cname.target}.`}</Code> : <p className="text-xs text-muted-foreground">{t("chatadmin.fed_cname_missing")}</p>}
                </div>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">{t("chat.external_privacy")}</p>
        </div>
      )}
    </section>
  );
}
