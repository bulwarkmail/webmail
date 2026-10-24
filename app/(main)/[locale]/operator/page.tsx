"use client";

// Operator console (O1–O3): own sign-in, companies (usage, blocking, limits),
// monthly report for invoices, company invitations (T1).
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { LogOut } from "@/components/icons";
import { CopyButton } from "@/components/xenaxio/copy-button";
import {
  OperatorReportView,
  OperatorTenants,
} from "@/components/xenaxio/operator-tenants";
import {
  AuthCard,
  Field,
  Notice,
  PasswordField,
  Spinner,
  TextField,
} from "@/components/xenaxio/ui";
import { errorKey, type Invitation, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

function SignIn({ onDone }: { onDone: () => void }) {
  const t = useXT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await xenaxio.operator.login(email.trim(), password);
      onDone();
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t("operator.sign_in")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice kind="error">{error}</Notice>}
        <TextField
          label={t("login.email")}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <PasswordField
          label={t("login.password")}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !email || !password}
        >
          {t("login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}

function Console({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  const t = useXT();
  const locale = useLocale();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [note, setNote] = useState("");
  const [lang, setLang] = useState<"de" | "en">("de");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"tenants" | "report" | "invitations">(
    "tenants",
  );

  const load = useCallback(() => {
    xenaxio.operator
      .invitations()
      .then((r) => setInvitations(r.invitations))
      .catch((err) => setError(t(errorKey(err))));
  }, [t]);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await xenaxio.operator.createInvitation(note.trim(), lang);
      setLink(res.url);
      setNote("");
      load();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  const isOpen = (i: Invitation) => !i.usedAt && !i.revokedAt && new Date(i.expiresAt) >= new Date();
  const status = (i: Invitation) =>
    i.usedAt
      ? t("operator.status_used", { tenant: i.tenantName ?? "—" })
      : i.revokedAt
        ? t("operator.status_revoked")
        : new Date(i.expiresAt) < new Date()
          ? t("operator.status_expired")
          : t("operator.status_open");

  // Step 26: take back a link that was not used yet.
  const revoke = async (i: Invitation) => {
    if (!window.confirm(t("operator.revoke_confirm"))) return;
    setError(null);
    try {
      await xenaxio.operator.revokeInvitation(i.id);
      load();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };
  const date = (s: string) => new Date(s).toLocaleDateString(locale);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-4xl px-4 h-14 flex items-center justify-between">
          <span className="text-sm font-semibold text-primary">
            {t("common.app_name")} · {t("operator.title")}
          </span>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-sm text-muted-foreground">
              {email}
            </span>
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut className="w-4 h-4 mr-1.5" />
              {t("common.sign_out")}
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 space-y-6">
        <nav
          className="flex gap-1 border-b border-border"
          aria-label={t("operator.title")}
        >
          {(["tenants", "report", "invitations"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t(`operator.tab_${k}`)}
            </button>
          ))}
        </nav>
        {tab === "tenants" && <OperatorTenants />}
        {tab === "report" && <OperatorReportView />}
        {tab === "invitations" && (
          <>
            {error && <Notice kind="error">{error}</Notice>}
            <section className="rounded-lg border border-border bg-card p-4 space-y-4">
              <h2 className="font-medium">{t("operator.new_invitation")}</h2>
              <form
                onSubmit={create}
                className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
              >
                <TextField
                  label={t("operator.note")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Field label={t("operator.language")} htmlFor="inv-lang">
                  <select
                    id="inv-lang"
                    value={lang}
                    onChange={(e) => setLang(e.target.value as "de" | "en")}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                  </select>
                </Field>
                <Button type="submit">{t("operator.create")}</Button>
              </form>
              {link && (
                <Notice kind="success">
                  <p className="mb-1">{t("operator.link_once")}</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 min-w-0 break-all font-mono text-xs">
                      {link}
                    </code>
                    <CopyButton value={link} />
                  </div>
                </Notice>
              )}
            </section>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {invitations.map((i) => (
                <li
                  key={i.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="font-medium">{i.note || "—"}</span>
                  <span className="text-muted-foreground">
                    {t("operator.col_created")}: {date(i.createdAt)} ·{" "}
                    {t("operator.col_expires")}: {date(i.expiresAt)} ·{" "}
                    {status(i)}
                  </span>
                  {isOpen(i) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => void revoke(i)}
                    >
                      {t("operator.revoke")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

export default function OperatorPage() {
  const t = useXT();
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "signed-out" }
    | { phase: "signed-in"; email: string }
  >({ phase: "loading" });

  const refresh = useCallback(() => {
    xenaxio.operator
      .me()
      .then((r) => setState({ phase: "signed-in", email: r.operator.email }))
      .catch(() => setState({ phase: "signed-out" }));
  }, []);
  useEffect(refresh, [refresh]);

  if (state.phase === "loading") return <Spinner label={t("common.loading")} />;
  if (state.phase === "signed-out") return <SignIn onDone={refresh} />;
  return (
    <Console
      email={state.email}
      onSignOut={async () => {
        await xenaxio.operator.logout().catch(() => {});
        setState({ phase: "signed-out" });
      }}
    />
  );
}
