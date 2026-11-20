"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiFetch, withBasePath } from "@/lib/browser-navigation";
import { getActiveAccountSlot, getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountSecurityStore } from "@/stores/account-security-store";
import { cn } from "@/lib/utils";

/**
 * Settings > Backup & import > Move from another server (#1760): copy the
 * user's own mailbox from an old server into this account. The job runs on
 * the server (app/api/migration); it signs in here with an app password this
 * page creates on the user's account. The user's own password is never sent.
 */

type ProtocolKey = "imap" | "carddav" | "caldav" | "sieve";
type FailureKind = "network" | "tls" | "auth" | "blocked" | "protocol";
type Status = "queued" | "mail" | "contacts" | "calendars" | "filters" | "paused" | "done" | "done_with_problems" | "failed" | "cancelled";
type ReportKind = "messages" | "folders" | "contacts" | "events" | "scripts";
type What = { mail: boolean; calendars: boolean; contacts: boolean; filters: boolean };

interface CountSet { copied: number; skipped: number; failed: number }

interface MigrationAccount {
  status: Status;
  pausedUntil?: number;
  progress: { messagesDone: number; messagesTotal: number };
  report: { counts: Record<ReportKind, CountSet>; problems: { phase: string; item?: string; reason: string }[]; problemCount: number };
  error?: string;
  errorCode?: string;
}

interface Migration {
  id: string;
  sourceName: string;
  finishedAt?: number;
  credentialsForgottenAt?: number;
  forgetAt?: number;
  appPasswordExpiresAt?: string;
  progress: { messagesDone: number; messagesTotal: number };
  running: boolean;
  account: MigrationAccount | null;
}

interface Overview {
  available: boolean;
  sources: { id: string; name: string; hasDav: boolean; hasSieve: boolean }[];
  allowOther: boolean;
  forgetAfterDays: number;
  migration: Migration | null;
}

type TestOutcome = { protocol: ProtocolKey; ok: true } | { protocol: ProtocolKey; ok: false; kind: FailureKind; error: string };

interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: (T & { error?: string; code?: string }) | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 5000;
const OTHER = "other";
const REPORT_KINDS: ReportKind[] = ["messages", "folders", "contacts", "events", "scripts"];
const PROTOCOLS: ProtocolKey[] = ["imap", "carddav", "caldav", "sieve"];

async function callMigration<T = Record<string, unknown>>(body?: Record<string, unknown>): Promise<ApiResult<T>> {
  const response = await apiFetch("/api/migration", body
    ? { method: "POST", headers: { "Content-Type": "application/json", ...getActiveAccountSlotHeaders() }, body: JSON.stringify(body) }
    : { headers: getActiveAccountSlotHeaders(), cache: "no-store" });
  const data = (await response.json().catch(() => null)) as ApiResult<T>["data"];
  return { ok: response.ok, status: response.status, data };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An app password on the user's own account that lasts as long as the stored passwords. Throws when Stalwart refuses. */
async function createMigrationAppPassword(forgetAfterDays: number): Promise<{ id: string; secret: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + Math.max(1, forgetAfterDays) * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const created = await useAccountSecurityStore.getState().createAppPassword({ description: `Mailbox migration ${today()}`, expiresAt });
  if (!created?.id || !created.secret) throw new Error("No app password");
  return { id: created.id, secret: created.secret, expiresAt };
}

function reportHref(): string {
  const slot = getActiveAccountSlot();
  return withBasePath(`/api/migration/report${slot === null ? "" : `?slot=${slot}`}`);
}

export function MailboxMigrationSettings() {
  const t = useTranslations("mailbox_migration");
  const locale = useLocale();
  const signedInUser = useAuthStore((s) => s.username);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecurity, setImapSecurity] = useState<"tls" | "starttls">("tls");
  const [caldavUrl, setCaldavUrl] = useState("");
  const [carddavUrl, setCarddavUrl] = useState("");
  const [sieveHost, setSieveHost] = useState("");
  const [sievePort, setSievePort] = useState("4190");
  const [username, setUsername] = useState(signedInUser ?? "");
  const [password, setPassword] = useState("");
  const [what, setWhat] = useState<What>({ mail: true, calendars: true, contacts: true, filters: true });
  const [busy, setBusy] = useState<"test" | "start" | "pass" | "cancel" | "finish" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestOutcome[] | null>(null);
  const [confirm, setConfirm] = useState<"finish" | "remove" | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (signedInUser) setUsername((current) => current || signedInUser);
  }, [signedInUser]);

  const load = useCallback(async () => {
    try {
      const result = await callMigration<Overview>();
      if (!mounted.current) return;
      setOverview(result.ok && result.data ? result.data : null);
    } catch {
      if (mounted.current) setOverview(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const running = !!overview?.migration?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  // The choices: the admin's sources, then "Other server". The first is picked until the user picks.
  const choices = overview ? [...overview.sources.map((s) => ({ value: s.id, label: s.name })), ...(overview.allowOther ? [{ value: OTHER, label: t("other_server") }] : [])] : [];
  const picked = choices.some((c) => c.value === sourceId) ? sourceId : (choices[0]?.value ?? "");

  if (!overview || !overview.available) return null;

  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(ms));
  const time = (ms: number) => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(ms));

  const errorText = (data: ApiResult["data"], status: number): string => {
    switch (data?.code) {
      case "blocked": return t("errors.blocked");
      case "not-allowed": return t("errors.not_allowed");
      case "dav-https": return t("errors.dav_https");
      case "none-security": return t("errors.none_security");
      case "active-exists": return t("errors.active_exists");
      case "rate-limited": return t("errors.rate_limited");
      case "wrong-account": return t("errors.wrong_account");
      case "app-password-refused": return t("errors.app_password_refused");
      case "login-missing": return t("errors.login_missing");
      case "untrusted": return t("errors.untrusted");
      case "finished": return t("errors.finished");
      case "forgotten": return t("errors.forgotten");
      case "user-access-expired": return t("errors.user_access_expired");
    }
    if (status === 429) return t("errors.rate_limited");
    return data?.error || t("errors.generic");
  };

  const statusText = (status: Status): string => {
    switch (status) {
      case "queued": return t("status.queued");
      case "mail": return t("status.mail");
      case "contacts": return t("status.contacts");
      case "calendars": return t("status.calendars");
      case "filters": return t("status.filters");
      case "paused": return t("status.paused");
      case "done": return t("status.done");
      case "done_with_problems": return t("status.done_with_problems");
      case "failed": return t("status.failed");
      case "cancelled": return t("status.cancelled");
    }
  };

  const protocolText = (protocol: ProtocolKey): string => {
    switch (protocol) {
      case "imap": return t("protocol.imap");
      case "carddav": return t("protocol.carddav");
      case "caldav": return t("protocol.caldav");
      case "sieve": return t("protocol.sieve");
    }
  };

  const failureText = (kind: FailureKind): string => {
    switch (kind) {
      case "tls": return t("test_kind.tls");
      case "auth": return t("test_kind.auth");
      case "network": return t("test_kind.network");
      case "blocked": return t("test_kind.blocked");
      default: return t("test_kind.protocol");
    }
  };

  const kindText = (kind: ReportKind): string => {
    switch (kind) {
      case "messages": return t("report.messages");
      case "folders": return t("report.folders");
      case "contacts": return t("report.contacts");
      case "events": return t("report.events");
      case "scripts": return t("report.scripts");
    }
  };

  /** The source part of a test or start request, or an error to show. */
  const sourceBody = (): { body: Record<string, unknown> } | { error: string } => {
    if (picked !== OTHER) return { body: { sourceId: picked } };
    if (!imapHost.trim()) return { error: t("errors.imap_host_missing") };
    for (const url of [caldavUrl, carddavUrl]) {
      if (url.trim() && !/^https:\/\//i.test(url.trim())) return { error: t("errors.dav_https") };
    }
    return {
      body: {
        sourceId: OTHER,
        custom: {
          imap: { host: imapHost.trim(), port: Number(imapPort) || 993, security: imapSecurity },
          ...(caldavUrl.trim() ? { caldavUrl: caldavUrl.trim() } : {}),
          ...(carddavUrl.trim() ? { carddavUrl: carddavUrl.trim() } : {}),
          ...(sieveHost.trim() ? { sieve: { host: sieveHost.trim(), port: Number(sievePort) || 4190 } } : {}),
        },
      },
    };
  };

  const loginBody = (): { username: string; password: string } | null => {
    if (!username.trim() || !password) return null;
    return { username: username.trim(), password };
  };

  const runTest = async () => {
    setError(null);
    setNotice(null);
    setTestResults(null);
    const source = sourceBody();
    if ("error" in source) { setError(source.error); return; }
    const login = loginBody();
    if (!login) { setError(t("errors.login_missing")); return; }
    setBusy("test");
    try {
      const result = await callMigration<{ results: TestOutcome[] }>({ action: "test", ...source.body, ...login });
      if (!mounted.current) return;
      if (result.ok && result.data?.results) setTestResults(result.data.results);
      else setError(errorText(result.data, result.status));
    } catch {
      if (mounted.current) setError(t("errors.generic"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const start = async () => {
    setError(null);
    setNotice(null);
    const source = sourceBody();
    if ("error" in source) { setError(source.error); return; }
    const login = loginBody();
    if (!login) { setError(t("errors.login_missing")); return; }
    if (!what.mail && !what.calendars && !what.contacts && !what.filters) { setError(t("errors.nothing_chosen")); return; }
    setBusy("start");
    try {
      let appPassword: { id: string; secret: string; expiresAt: string };
      try {
        appPassword = await createMigrationAppPassword(overview.forgetAfterDays);
      } catch {
        if (mounted.current) setError(t("errors.no_app_passwords"));
        return;
      }
      let result: ApiResult | null = null;
      try {
        result = await callMigration({ action: "start", ...source.body, ...login, what, appPassword });
      } catch {
        result = null;
      }
      if (!result?.ok) {
        // Best effort: the server keeps nothing of a refused start.
        void useAccountSecurityStore.getState().removeAppPassword(appPassword.id).catch(() => {});
        if (mounted.current) setError(result ? errorText(result.data, result.status) : t("errors.generic"));
        return;
      }
      if (!mounted.current) return;
      setPassword("");
      setTestResults(null);
      await load();
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const copyNew = async () => {
    const migration = overview.migration;
    if (!migration) return;
    setError(null);
    setNotice(null);
    setBusy("pass");
    try {
      const expiresSoon = !!migration.appPasswordExpiresAt && Date.parse(migration.appPasswordExpiresAt) - Date.now() < DAY_MS;
      let result: ApiResult<{ renew?: boolean; queued?: number }> | null = null;
      if (!expiresSoon) {
        result = await callMigration<{ renew?: boolean; queued?: number }>({ action: "pass" });
        if (!result.ok) {
          if (mounted.current) setError(errorText(result.data, result.status));
          return;
        }
      }
      if (expiresSoon || result?.data?.renew) {
        let appPassword: { id: string; secret: string; expiresAt: string };
        try {
          appPassword = await createMigrationAppPassword(overview.forgetAfterDays);
        } catch {
          if (mounted.current) setError(t("errors.no_app_passwords"));
          return;
        }
        result = await callMigration<{ renew?: boolean; queued?: number }>({ action: "pass", appPassword });
        if (!result.ok) {
          void useAccountSecurityStore.getState().removeAppPassword(appPassword.id).catch(() => {});
          if (mounted.current) setError(errorText(result.data, result.status));
          return;
        }
      }
      if (!mounted.current) return;
      setNotice(t("pass_queued"));
      await load();
    } catch {
      if (mounted.current) setError(t("errors.generic"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const simpleAction = async (action: "cancel" | "finish" | "remove") => {
    setError(null);
    setNotice(null);
    setBusy(action);
    try {
      const result = await callMigration({ action });
      if (!mounted.current) return;
      if (!result.ok) setError(errorText(result.data, result.status));
      await load();
    } catch {
      if (mounted.current) setError(t("errors.generic"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const migration = overview.migration;
  const account = migration?.account ?? null;
  const showForm = !migration || !!migration.finishedAt;
  const otherPicked = picked === OTHER;
  const fieldGrid = "grid grid-cols-1 gap-3 sm:grid-cols-2";

  return (
    <SettingsSection id="mailbox-migration" title={t("section_title")} description={t("section_description")}>
      {migration && (
        <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm min-w-0" data-testid="mailbox-migration-status">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 min-w-0">
            <p className="min-w-0 truncate text-foreground">{t("source_label", { name: migration.sourceName })}</p>
            {account && (
              <span className={cn("font-medium", account.status === "failed" ? "text-destructive" : "text-foreground")} data-testid="mailbox-migration-state">
                {statusText(account.status)}
              </span>
            )}
          </div>
          {account && account.progress.messagesTotal > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.round((account.progress.messagesDone / account.progress.messagesTotal) * 100))}%` }} />
              </div>
              <p className="text-muted-foreground">
                {t("progress", { done: number(account.progress.messagesDone), total: number(account.progress.messagesTotal) })}
              </p>
            </div>
          )}
          {account?.status === "paused" && account.pausedUntil && (
            <p className="text-muted-foreground">{t("paused_until", { time: time(account.pausedUntil) })}</p>
          )}
          {account?.status === "failed" && account.error && (
            <p className="text-destructive wrap-anywhere">{account.errorCode === "target-auth" ? t("errors.user_access_expired") : account.error}</p>
          )}
          {account && (account.status === "done" || account.status === "done_with_problems" || account.status === "failed" || account.status === "cancelled" || account.report.problemCount > 0) && (
            <div className="space-y-2">
              <p className="font-medium text-foreground">{t("report.title")}</p>
              <ul className="space-y-1 text-muted-foreground">
                {REPORT_KINDS.map((kind) => {
                  const c = account.report.counts[kind];
                  if (!c) return null;
                  return (
                    <li key={kind} className="flex flex-wrap gap-x-2 min-w-0">
                      <span className="font-medium text-foreground">{kindText(kind)}</span>
                      <span>{t("report.counts", { copied: c.copied, skipped: c.skipped, failed: c.failed })}</span>
                    </li>
                  );
                })}
              </ul>
              {account.report.problemCount > 0 && (
                <div className="space-y-1">
                  <p className="text-foreground">{t("report.problems", { count: account.report.problemCount })}</p>
                  <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
                    {account.report.problems.map((p, i) => (
                      <li key={i} className="wrap-anywhere">{p.item ? `${p.item}: ${p.reason}` : p.reason}</li>
                    ))}
                  </ul>
                  {account.report.problemCount > account.report.problems.length && (
                    <p className="text-xs text-muted-foreground">{t("report.more_problems", { count: account.report.problemCount - account.report.problems.length })}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {migration.forgetAt && !migration.finishedAt && (
            <p className="text-muted-foreground">{t("forget_at", { date: date(migration.forgetAt) })}</p>
          )}
          {migration.finishedAt && <p className="text-muted-foreground">{t("finished_note")}</p>}
          {!migration.finishedAt && migration.credentialsForgottenAt && <p className="text-muted-foreground">{t("errors.forgotten")}</p>}

          <div className="flex flex-wrap gap-2">
            {!migration.finishedAt && !migration.credentialsForgottenAt && !migration.running && (
              <div className="w-full space-y-1">
                <Button size="sm" onClick={() => void copyNew()} disabled={busy !== null} data-testid="mailbox-migration-pass">
                  {t("copy_new")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("copy_new_note")}</p>
              </div>
            )}
            {migration.running && (
              <Button size="sm" variant="outline" onClick={() => void simpleAction("cancel")} disabled={busy !== null} data-testid="mailbox-migration-cancel">
                {t("cancel")}
              </Button>
            )}
            {!migration.finishedAt && (
              <Button size="sm" variant="outline" onClick={() => setConfirm("finish")} disabled={busy !== null} data-testid="mailbox-migration-finish">
                {t("finish")}
              </Button>
            )}
            {(migration.finishedAt || !migration.running) && (
              <Button size="sm" variant="outline" onClick={() => setConfirm("remove")} disabled={busy !== null} data-testid="mailbox-migration-remove">
                {t("remove")}
              </Button>
            )}
            <a
              href={reportHref()}
              download
              className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-sm text-foreground hover:bg-muted"
              data-testid="mailbox-migration-report"
            >
              {t("download_report")}
            </a>
          </div>
        </div>
      )}

      {showForm && (
        <div className="space-y-4 min-w-0" data-testid="mailbox-migration-form">
          {choices.length > 1 && (
            <Field label={t("source_picker")}>
              <select
                value={picked}
                onChange={(e) => { setSourceId(e.target.value); setTestResults(null); }}
                className="h-10 w-full max-w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                data-testid="mailbox-migration-source"
              >
                {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
          )}

          {otherPicked && (
            <div className="space-y-3" data-testid="mailbox-migration-other">
              <div className={fieldGrid}>
                <Field label={t("imap_host")} className="min-w-0">
                  <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.example.com" autoComplete="off" spellCheck={false} />
                </Field>
                <div className="grid grid-cols-2 gap-3 min-w-0">
                  <Field label={t("imap_port")} className="min-w-0">
                    <Input value={imapPort} onChange={(e) => setImapPort(e.target.value)} inputMode="numeric" />
                  </Field>
                  <Field label={t("imap_security")} className="min-w-0">
                    <select
                      value={imapSecurity}
                      onChange={(e) => {
                        const next = e.target.value === "starttls" ? "starttls" : "tls";
                        setImapSecurity(next);
                        if (next === "starttls" && imapPort === "993") setImapPort("143");
                        if (next === "tls" && imapPort === "143") setImapPort("993");
                      }}
                      className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    >
                      <option value="tls">{t("security_tls")}</option>
                      <option value="starttls">{t("security_starttls")}</option>
                    </select>
                  </Field>
                </div>
                <Field label={t("caldav_url")} hint={t("optional")} className="min-w-0">
                  <Input value={caldavUrl} onChange={(e) => setCaldavUrl(e.target.value)} placeholder="https://" type="url" autoComplete="off" spellCheck={false} />
                </Field>
                <Field label={t("carddav_url")} hint={t("optional")} className="min-w-0">
                  <Input value={carddavUrl} onChange={(e) => setCarddavUrl(e.target.value)} placeholder="https://" type="url" autoComplete="off" spellCheck={false} />
                </Field>
                <Field label={t("sieve_host")} hint={t("optional")} className="min-w-0">
                  <Input value={sieveHost} onChange={(e) => setSieveHost(e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label={t("sieve_port")} className="min-w-0">
                  <Input value={sievePort} onChange={(e) => setSievePort(e.target.value)} inputMode="numeric" />
                </Field>
              </div>
            </div>
          )}

          <div className={fieldGrid}>
            <Field label={t("username")} className="min-w-0">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} data-testid="mailbox-migration-username" />
            </Field>
            <Field label={t("password")} className="min-w-0">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" data-testid="mailbox-migration-password" />
            </Field>
          </div>

          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t("what_label")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-foreground">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="rounded border-border" checked={what.mail} onChange={(e) => setWhat({ ...what, mail: e.target.checked })} />
                <span>{t("what_mail")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="rounded border-border" checked={what.calendars} onChange={(e) => setWhat({ ...what, calendars: e.target.checked })} />
                <span>{t("what_calendars")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="rounded border-border" checked={what.contacts} onChange={(e) => setWhat({ ...what, contacts: e.target.checked })} />
                <span>{t("what_contacts")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="rounded border-border" checked={what.filters} onChange={(e) => setWhat({ ...what, filters: e.target.checked })} />
                <span>{t("what_filters")}</span>
              </label>
            </div>
          </fieldset>

          <p className="text-xs text-muted-foreground">{t("app_password_note", { days: overview.forgetAfterDays })}</p>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void runTest()} disabled={busy !== null} data-testid="mailbox-migration-test">
              {busy === "test" ? t("testing") : t("test")}
            </Button>
            <Button size="sm" onClick={() => void start()} disabled={busy !== null} data-testid="mailbox-migration-start">
              {busy === "start" ? t("starting") : t("start")}
            </Button>
          </div>

          {testResults && (
            <ul className="space-y-1 text-sm" data-testid="mailbox-migration-test-results">
              {PROTOCOLS.map((protocol) => {
                const outcome = testResults.find((r) => r.protocol === protocol);
                if (!outcome) return null;
                return (
                  <li key={protocol} className="flex flex-wrap gap-x-2 min-w-0">
                    <span className="font-medium text-foreground">{protocolText(protocol)}</span>
                    {outcome.ok
                      ? <span className="text-success">{t("test_ok")}</span>
                      : <span className="text-destructive wrap-anywhere min-w-0">{failureText(outcome.kind)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive wrap-anywhere" data-testid="mailbox-migration-error">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action) void simpleAction(action);
        }}
        title={confirm === "remove" ? t("remove_confirm_title") : t("finish_confirm_title")}
        message={confirm === "remove" ? t("remove_confirm_message") : t("finish_confirm_message")}
        confirmText={confirm === "remove" ? t("remove") : t("finish")}
        variant={confirm === "remove" ? "destructive" : "default"}
      />
    </SettingsSection>
  );
}
