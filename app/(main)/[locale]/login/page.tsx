"use client";

// xenaxio sign-in (spec A1): the browser posts the credentials to our BFF,
// which signs in to the mail server and answers with an httpOnly session
// cookie. The password never stays in the browser. Replaces Bulwark's login
// page; the route stays /login so every existing redirect keeps working.
import { type FormEvent, Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { withBasePath } from "@/lib/browser-navigation";
import { Button } from "@/components/ui/button";
import { AuthCard, Notice, PasswordField, TextField } from "@/components/xenaxio/ui";
import { errorKey, xenaxio } from "@/lib/xenaxio/api";
import { clearAssistantState } from "@/lib/xenaxio/assistant";
import { useXT } from "@/lib/xenaxio/i18n";
import { safeNextPath } from "@/lib/xenaxio/brand";
import { goToPortal, shouldHandOff, usePortal } from "@/lib/xenaxio/portal";
import { openAccount } from "@/lib/xenaxio/accounts";

function LoginForm() {
  const t = useXT();
  const router = useRouter();
  const locale = useLocale();
  const params = useSearchParams();
  // Back to where sign-in was needed, e.g. the consent screen of an AI chat (step 9).
  const next = safeNextPath(params.get("next"));
  // Step 29: "Add account" in the account menu; the accounts signed in here stay.
  const add = params.get("mode") === "add-account";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portal = usePortal();
  const company = portal?.kind === "tenant" ? portal : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await xenaxio.login(email.trim(), password, locale, add ? { next: `/${locale}/` } : undefined);
      setPassword("");
      // A new sign-in never inherits an assistant chat left in this tab.
      clearAssistantState();
      // Step 29: the added account opens here or on its company's portal.
      if (add && me.url) return openAccount(me.url);
      // Step 17: signed in on the shared address — continue on the company's own one
      // (not when sign-in was for something specific here, e.g. an AI chat's consent).
      const target = me.user.mustChangePassword ? `/${locale}/workspace/password/` : `/${locale}/`;
      if (!next && shouldHandOff(me.portalUrl, window.location.origin, window.location.pathname) && (await goToPortal(target))) return;
      // Full navigation: the mail app restores the session from the new cookie on load.
      if (me.user.mustChangePassword) router.replace("/workspace/password");
      else window.location.assign(withBasePath(next ?? `/${locale}/`));
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={add ? t("login.add_title") : t("login.title")}
      subtitle={add ? t("login.add_subtitle") : company ? t("portal.login_subtitle", { company: company.name }) : t("login.subtitle")}
    >
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
        {add && (
          <Button type="button" variant="ghost" className="w-full" onClick={() => window.location.assign(withBasePath(`/${locale}/`))}>
            {t("common.cancel")}
          </Button>
        )}
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
