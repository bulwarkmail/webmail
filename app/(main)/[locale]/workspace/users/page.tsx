"use client";

// Employees (scenario 2, A2, C1): add, reset passwords, aliases, mailbox size,
// AI per person (I8), disable and re-enable, delete (step 17).
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, Pencil, Plus } from "@/components/icons";
import { Field, Notice, PasswordField, TextField } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, errorText, type WorkspaceUser, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  // Small mailboxes would otherwise all read "0 MB".
  return `${(bytes / MB).toLocaleString(undefined, { maximumFractionDigits: bytes < 10 * MB ? 1 : 0 })} MB`;
}

/** C1 and I8 settings of one employee. */
function UserEditor({ user, isSelf, maxQuotaBytes, aiEnabled, onChanged, onMessage }: {
  user: WorkspaceUser;
  isSelf: boolean;
  maxQuotaBytes: number;
  aiEnabled: boolean | undefined;
  onChanged: () => Promise<void>;
  onMessage: (m: { kind: "error" | "success"; text: string }) => void;
}) {
  const t = useXT();
  const [aliases, setAliases] = useState(user.aliases.join(", "));
  const [quotaMb, setQuotaMb] = useState(String(Math.round(user.quotaBytes / MB)));
  const [busy, setBusy] = useState(false);
  // Step 17: errors and confirmations show here, next to the button, not at the top of the page.
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string; field?: "aliases" } | null>(null);
  const run = async (action: () => Promise<unknown>, success?: string, field?: "aliases") => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice({ kind: "success", text: success });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err), field });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const typed = window.prompt(t("users.delete_prompt", { email: user.email }));
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== user.email.toLowerCase()) {
      setNotice({ kind: "error", text: t("users.delete_mismatch") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await xenaxio.deleteUser(user.id);
      onMessage({ kind: "success", text: t("users.deleted", { email: user.email }) });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
      setBusy(false);
    }
  };
  const aliasError = notice?.kind === "error" && notice.field === "aliases" ? notice.text : undefined;
  const list = aliases.split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);

  return (
    <div className="space-y-4 rounded-md bg-muted/50 p-3">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => xenaxio.setAliases(user.id, list), t("users.aliases_saved"), "aliases");
        }}
      >
        <TextField label={t("users.aliases")} hint={t("users.aliases_hint")} error={aliasError} value={aliases} onChange={(e) => setAliases(e.target.value)} autoCapitalize="none" spellCheck={false} />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>{t("users.aliases_save")}</Button>
      </form>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => xenaxio.setQuota(user.id, Number(quotaMb)), t("users.quota_saved"));
        }}
      >
        <TextField
          label={t("users.quota")}
          hint={t("users.quota_hint", { max: Math.round(maxQuotaBytes / MB).toLocaleString() })}
          type="number"
          min={100}
          max={Math.round(maxQuotaBytes / MB)}
          value={quotaMb}
          onChange={(e) => setQuotaMb(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !Number(quotaMb)}>{t("users.quota_save")}</Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {aiEnabled !== undefined && (
          <Button size="sm" variant={aiEnabled ? "default" : "outline"} disabled={busy} aria-pressed={aiEnabled} onClick={() => run(() => xenaxio.setUserAi(user.id, !aiEnabled))}>
            {t("users.ai")}: {aiEnabled ? t("users.ai_on") : t("users.ai_off")}
          </Button>
        )}
        {!isSelf && (
          <Button
            size="sm"
            variant="outline"
            className={user.status === "active" ? "text-destructive" : ""}
            disabled={busy}
            onClick={() => {
              if (user.status === "active" && !window.confirm(t("users.disable_confirm", { email: user.email }))) return;
              void run(() => xenaxio.setUserStatus(user.id, user.status === "active" ? "disabled" : "active"));
            }}
          >
            {user.status === "active" ? t("users.disable") : t("users.enable")}
          </Button>
        )}
        {!isSelf && (
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void remove()}>
            {t("users.delete")}
          </Button>
        )}
      </div>
      {notice && !aliasError && <Notice kind={notice.kind}>{notice.text}</Notice>}
    </div>
  );
}

function UsersView() {
  const t = useXT();
  const me = useMe();
  const domain = me.user.email.split("@")[1] ?? "";
  const [users, setUsers] = useState<WorkspaceUser[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [maxQuota, setMaxQuota] = useState(0);
  const [ai, setAi] = useState<Map<string, boolean> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: "", localPart: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [resetting, setResetting] = useState<WorkspaceUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await xenaxio.users();
      setUsers(res.users);
      setLimit(res.limits.maxMailboxes);
      setMaxQuota(res.limits.mailboxQuotaBytes);
      // AI per person is shown only when the platform has AI configured.
      const aiInfo = await xenaxio.aiAdmin().catch(() => null);
      setAi(aiInfo?.configured ? new Map(aiInfo.users.map((u) => [u.id, u.aiEnabled])) : null);
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const user = await xenaxio.createUser({ ...form, localPart: form.localPart.trim().toLowerCase() });
      setForm({ displayName: "", localPart: "", password: "" });
      setMessage({ kind: "success", text: t("users.created", { email: user.email }) });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetting) return;
    setBusy(true);
    setMessage(null);
    try {
      await xenaxio.resetPassword(resetting.id, resetPassword);
      setResetting(null);
      setResetPassword("");
      setMessage({ kind: "success", text: t("users.reset_done") });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    } finally {
      setBusy(false);
    }
  };

  if (!users) return message ? <Notice kind="error">{message.text}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <h2 className="font-medium">{t("users.add")}</h2>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2" noValidate>
          <TextField label={t("users.name")} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          <Field label={t("users.address")} htmlFor="new-user-address">
            <div className="flex items-center gap-2">
              <Input
                id="new-user-address"
                value={form.localPart}
                onChange={(e) => setForm({ ...form, localPart: e.target.value })}
                autoCapitalize="none"
                spellCheck={false}
                className="flex-1 min-w-0"
                required
              />
              <span className="text-sm text-muted-foreground truncate max-w-[50%]">@{domain}</span>
            </div>
          </Field>
          <div className="sm:col-span-2">
            <PasswordField
              label={t("users.temp_password")}
              hint={t("users.temp_password_hint")}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy || !form.displayName || !form.localPart || form.password.length < 10}>
              <Plus className="w-4 h-4 mr-1.5" />
              {busy ? t("users.creating") : t("users.create")}
            </Button>
          </div>
        </form>
      </section>

      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("users.count", { count: users.length, limit })}</p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {users.map((u) => (
            <li key={u.id} className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{u.displayName}</p>
                  <p className="text-sm text-muted-foreground truncate">{u.email}</p>
                  {u.aliases.length > 0 && <p className="text-xs text-muted-foreground truncate">{u.aliases.map((a) => `${a}@${domain}`).join(", ")}</p>}
                  <p className="text-xs text-muted-foreground">
                    {t("users.used", { used: u.usedBytes != null ? formatBytes(u.usedBytes) : "–", quota: formatBytes(u.quotaBytes) })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-muted px-2.5 py-0.5">{u.role === "admin" ? t("users.role_admin") : t("users.role_user")}</span>
                  {u.status === "disabled" && <span className="rounded-full bg-destructive/15 px-2.5 py-0.5 text-destructive">{t("users.disabled_badge")}</span>}
                  {ai?.get(u.id) && <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-primary">{t("users.ai_on")}</span>}
                  {u.mustChangePassword && <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-amber-700 dark:text-amber-400">{t("users.must_change")}</span>}
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === u.id ? null : u.id)} aria-expanded={editing === u.id}>
                    <Pencil className="w-4 h-4 mr-1.5" />
                    {t("users.edit")}
                  </Button>
                  {u.id !== me.user.id && (
                    <Button variant="outline" size="sm" onClick={() => setResetting(resetting?.id === u.id ? null : u)}>
                      <KeyRound className="w-4 h-4 mr-1.5" />
                      {t("users.reset")}
                    </Button>
                  )}
                </div>
              </div>
              {editing === u.id && (
                <UserEditor
                  key={`${u.id}-${u.aliases.join()}-${u.quotaBytes}`}
                  user={u}
                  isSelf={u.id === me.user.id}
                  maxQuotaBytes={maxQuota}
                  aiEnabled={ai?.get(u.id)}
                  onChanged={load}
                  onMessage={setMessage}
                />
              )}
              {resetting?.id === u.id && (
                <form onSubmit={reset} className="space-y-3 rounded-md bg-muted/50 p-3" noValidate>
                  <PasswordField
                    label={t("users.reset_title", { email: u.email })}
                    hint={t("users.temp_password_hint")}
                    autoComplete="new-password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    required
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy || resetPassword.length < 10}>
                      {t("users.reset_submit")}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setResetting(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function UsersPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("users.title")} backHref="/workspace" requireAdmin>
      <UsersView />
    </WorkspaceShell>
  );
}
