"use client";

// xenaxio sign-in (spec A1): the browser posts the credentials to our BFF,
// which signs in to the mail server and answers with an httpOnly session
// cookie. The password never stays in the browser. Replaces Bulwark's login
// page; the route stays /login so every existing redirect keeps working.
import { type FormEvent, Suspense, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { withBasePath } from "@/lib/browser-navigation";
import { Button } from "@/components/ui/button";
import { AuthCard, Notice, PasswordField, TextField } from "@/components/xenaxio/ui";
import { errorKey, xenaxio } from "@/lib/xenaxio/api";
import { clearAssistantState } from "@/lib/xenaxio/assistant";
import { useXT } from "@/lib/xenaxio/i18n";

function LoginForm() {
  const t = useXT();
  const router = useRouter();
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await xenaxio.login(email.trim(), password);
      setPassword("");
      // A new sign-in never inherits an assistant chat left in this tab.
      clearAssistantState();
      // Full navigation: the mail app restores the session from the new cookie on load.
      if (me.user.mustChangePassword) router.replace("/workspace/password");
      else window.location.assign(withBasePath(`/${locale}/`));
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("login.title")} subtitle={t("login.subtitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice kind="error">{error}</Notice>}
        <TextField
          label={t("login.email")}
          type="email"
          autoComplete="username"
          placeholder={t("login.email_placeholder")}
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
        <Button type="submit" className="w-full" disabled={busy || !email || !password}>
          {busy ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
