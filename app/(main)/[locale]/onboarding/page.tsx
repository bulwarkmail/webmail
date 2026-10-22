"use client";

// Company set-up from the operator's invitation link (T1, T2).
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { AuthCard, Field, Notice, PasswordField, TextField } from "@/components/xenaxio/ui";
import { Input } from "@/components/ui/input";
import { errorKey, type SlugProblem, xenaxio, XenaxioApiError } from "@/lib/xenaxio/api";
import { goToPortal, shouldHandOff } from "@/lib/xenaxio/portal";
import { useLocale } from "next-intl";
import { useXT } from "@/lib/xenaxio/i18n";

type Status = "checking" | "valid" | "used" | "expired" | "unknown";

function OnboardingForm() {
  const t = useXT();
  const router = useRouter();
  const locale = useLocale();
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<Status>("checking");
  const [form, setForm] = useState({ companyName: "", domain: "", adminName: "", adminLocalPart: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Step 17: the company's address <slug>.<baseDomain>; suggested from the name until edited.
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [baseDomain, setBaseDomain] = useState<string | null>(null);
  const [slugProblem, setSlugProblem] = useState<SlugProblem | null>(null);

  useEffect(() => {
    if (!token) return setStatus("unknown");
    xenaxio
      .invitationStatus(token)
      .then((r) => setStatus(r.status))
      .catch(() => setStatus("unknown"));
  }, [token]);

  // Suggestion from the company name (while the address was not edited by hand).
  useEffect(() => {
    if (status !== "valid" || slugEdited) return;
    const name = form.companyName.trim();
    const timer = setTimeout(() => {
      xenaxio
        .onboardingSlug(token, { name: name || "firma" })
        .then((r) => {
          setBaseDomain(r.baseDomain || null);
          if (name && r.suggestion) setSlug(r.suggestion);
          setSlugProblem(null);
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [form.companyName, slugEdited, status, token]);

  // A typed address: is it free?
  useEffect(() => {
    if (status !== "valid" || !slugEdited) return;
    if (!slug) return setSlugProblem("invalid");
    const timer = setTimeout(() => {
      xenaxio
        .onboardingSlug(token, { slug })
        .then((r) => setSlugProblem(r.problem ?? null))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [slug, slugEdited, status, token]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  // Pasted addresses or URLs: keep only the domain part.
  const domain = form.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^.*@/, "").replace(/\/.*$/, "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const me = await xenaxio.onboard({
        token,
        ...form,
        domain,
        adminLocalPart: form.adminLocalPart.trim().toLowerCase(),
        ...(baseDomain && slug ? { slug } : {}),
      });
      // Step 17: continue on the company's own address.
      if (shouldHandOff(me.portalUrl, window.location.origin, "/") && (await goToPortal(`/${locale}/workspace/domain/`))) return;
      router.replace("/workspace/domain");
    } catch (err) {
      if (err instanceof XenaxioApiError && err.issues?.length) {
        setFieldErrors(Object.fromEntries(err.issues.map((i) => [i.path, t(`errors.${/^[a-z_]+$/.test(i.message) ? i.message : "validation"}`)])));
      }
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };

  if (status === "checking") {
    return (
      <AuthCard title={t("onboarding.title")}>
        <p className="text-sm text-muted-foreground">{t("onboarding.checking")}</p>
      </AuthCard>
    );
  }
  if (status !== "valid") {
    return (
      <AuthCard title={t("onboarding.title")}>
        <Notice kind="error">{t(`errors.invitation_${status}`)}</Notice>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("onboarding.title")} subtitle={t("onboarding.subtitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice kind="error">{error}</Notice>}
        <TextField label={t("onboarding.company")} value={form.companyName} onChange={set("companyName")} autoComplete="organization" error={fieldErrors.companyName} required autoFocus />
        <TextField
          label={t("onboarding.domain")}
          hint={t("onboarding.domain_hint")}
          value={form.domain}
          onChange={set("domain")}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="mueller-gmbh.de"
          error={fieldErrors.domain}
          required
        />
        {baseDomain && (
          <Field
            label={t("onboarding.address")}
            htmlFor="portal-address"
            hint={slugProblem ? undefined : t("onboarding.address_hint")}
            error={slugProblem ? t(`errors.slug_${slugProblem}`) : fieldErrors.slug}
          >
            <div className="flex items-center gap-2">
              <Input
                id="portal-address"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40));
                }}
                autoCapitalize="none"
                spellCheck={false}
                placeholder="mueller"
                className="flex-1 min-w-0"
                aria-invalid={slugProblem ? true : undefined}
              />
              <span className="text-sm text-muted-foreground truncate max-w-[55%]">.{baseDomain}</span>
            </div>
          </Field>
        )}
        <TextField label={t("onboarding.admin_name")} value={form.adminName} onChange={set("adminName")} autoComplete="name" error={fieldErrors.adminName} required />
        <Field label={t("onboarding.admin_address")} htmlFor="admin-address" error={fieldErrors.adminLocalPart}>
          <div className="flex items-center gap-2">
            <Input
              id="admin-address"
              value={form.adminLocalPart}
              onChange={set("adminLocalPart")}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="max"
              className="flex-1 min-w-0"
              required
            />
            <span className="text-sm text-muted-foreground truncate max-w-[50%]">@{domain || "…"}</span>
          </div>
        </Field>
        <PasswordField
          label={t("onboarding.password")}
          hint={t("password.hint")}
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          error={fieldErrors.password}
          required
        />
        <Button type="submit" className="w-full" disabled={busy || !form.companyName || !domain || !form.adminName || !form.adminLocalPart || form.password.length < 10 || (!!baseDomain && (!slug || !!slugProblem))}>
          {busy ? t("onboarding.submitting") : t("onboarding.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingForm />
    </Suspense>
  );
}
