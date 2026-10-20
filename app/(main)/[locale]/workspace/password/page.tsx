"use client";

// Own password change (A2). Also the forced step after a temporary password.
import { type FormEvent, useState } from "react";
import { useLocale } from "next-intl";
import { withBasePath } from "@/lib/browser-navigation";
import { Button } from "@/components/ui/button";
import { Notice, PasswordField } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

const MIN_LENGTH = 10;

function PasswordForm() {
  const t = useXT();
  const locale = useLocale();
  const me = useMe();
  const forced = me.user.mustChangePassword;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || tooShort) return;
    setBusy(true);
    setError(null);
    try {
      await xenaxio.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      // Full navigation: the mail app restores the session on load.
      if (forced) window.location.assign(withBasePath(`/${locale}/`));
      else setDone(true);
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
      {forced && <Notice kind="info">{t("password.forced")}</Notice>}
      {done && <Notice kind="success">{t("password.done")}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <PasswordField label={t("password.current")} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <PasswordField
        label={t("password.new")}
        autoComplete="new-password"
        hint={t("password.hint")}
        error={tooShort ? t("errors.password_too_short") : undefined}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        required
      />
      <PasswordField
        label={t("password.confirm")}
        autoComplete="new-password"
        error={mismatch ? t("password.mismatch") : undefined}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      <Button type="submit" disabled={busy || !current || !next || mismatch || tooShort || next !== confirm}>
        {t("password.submit")}
      </Button>
    </form>
  );
}

export default function PasswordPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("password.title")} backHref="/workspace" allowTemporaryPassword>
      <PasswordForm />
    </WorkspaceShell>
  );
}
