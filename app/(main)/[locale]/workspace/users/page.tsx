"use client";

// Employees (scenario 2, A2): add with a temporary password, reset passwords.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, Plus } from "@/components/icons";
import { Field, Notice, PasswordField, TextField } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, type WorkspaceUser, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

function UsersView() {
  const t = useXT();
  const me = useMe();
  const domain = me.user.email.split("@")[1] ?? "";
  const [users, setUsers] = useState<WorkspaceUser[] | null>(null);
  const [limit, setLimit] = useState(0);
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
      setMessage({ kind: "error", text: t(errorKey(err)) });
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
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-muted px-2.5 py-0.5">{u.role === "admin" ? t("users.role_admin") : t("users.role_user")}</span>
                  {u.mustChangePassword && <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-amber-700 dark:text-amber-400">{t("users.must_change")}</span>}
                  {u.id !== me.user.id && (
                    <Button variant="outline" size="sm" onClick={() => setResetting(resetting?.id === u.id ? null : u)}>
                      <KeyRound className="w-4 h-4 mr-1.5" />
                      {t("users.reset")}
                    </Button>
                  )}
                </div>
              </div>
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
