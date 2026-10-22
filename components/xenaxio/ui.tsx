"use client";

// Building blocks of the xenaxio pages, styled with the client's theme tokens.
import { useId, useState, type ReactNode } from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { AlertCircle, CheckCircle, Eye, EyeOff, Info } from "@/components/icons";
import { useConfig } from "@/hooks/use-config";
import { useThemeStore } from "@/stores/theme-store";
import { withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";
import { safeHttpUrl } from "@/lib/xenaxio/brand";
import { usePortal } from "@/lib/xenaxio/portal";

/** Centered card for sign-in, password and onboarding pages. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const t = useXT();
  // Brand logo and wordmark from config.json (W1). Shown only once the config
  // is loaded, so the upstream default logo never flashes.
  const { appLogoLightUrl, loginLogoLightUrl, loginLogoDarkUrl, loginWebsiteUrl, loginImprintUrl, loginPrivacyPolicyUrl, isLoading } =
    useConfig();
  const dark = useThemeStore((s) => s.resolvedTheme) === "dark";
  const wordmark = isLoading ? "" : dark ? loginLogoDarkUrl || loginLogoLightUrl : loginLogoLightUrl || loginLogoDarkUrl;
  // Public website, imprint and privacy policy of the operator (config.json:
  // loginWebsiteUrl, loginImprintUrl, loginPrivacyPolicyUrl). Empty = hidden.
  const website = isLoading ? "" : safeHttpUrl(loginWebsiteUrl);
  const legal = isLoading
    ? []
    : [
        { href: safeHttpUrl(loginImprintUrl), label: t("common.imprint") },
        { href: safeHttpUrl(loginPrivacyPolicyUrl), label: t("common.privacy") },
      ].filter((l) => l.href);
  // Step 17: on a company portal its logo (or name) instead of xenaxio's.
  const portal = usePortal();
  const company = portal?.kind === "tenant" ? portal : null;
  const waiting = isLoading || !portal;
  const brand = company ? (
    company.logoUrl ? (
      <img src={withBasePath(company.logoUrl)} alt={company.name} className="max-h-16 max-w-[240px] w-auto object-contain" />
    ) : (
      <p className="text-center text-xl font-semibold">{company.name}</p>
    )
  ) : (
    <>
      {!waiting && appLogoLightUrl && <img src={withBasePath(appLogoLightUrl)} alt="" className="h-14 w-14" />}
      {waiting ? (
        <div className="h-20" />
      ) : wordmark ? (
        <img src={withBasePath(wordmark)} alt={t("common.app_name")} className="h-6 w-auto" />
      ) : (
        <p className="text-center text-sm font-semibold tracking-wide text-primary">{t("common.app_name")}</p>
      )}
    </>
  );
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        {website ? (
          <a
            href={website}
            title={t("common.to_website")}
            className="mb-6 flex flex-col items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {brand}
          </a>
        ) : (
          <div className="mb-6 flex flex-col items-center gap-3">{brand}</div>
        )}
        <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm p-6 sm:p-8">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {company && <p className="mt-4 text-center text-xs text-muted-foreground">{t("portal.powered_by")}</p>}
        {(website || legal.length > 0) && (
          <nav className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {website && (
              <a href={website} className="hover:text-foreground hover:underline">
                ← {t("common.to_website")}
              </a>
            )}
            {legal.map((l) => (
              <a key={l.href} href={l.href} className="hover:text-foreground hover:underline">
                {l.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </main>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function TextField({ label, hint, error, ...props }: InputProps & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

export function PasswordField({ label, hint, error, ...props }: InputProps & { label: string; hint?: string; error?: string }) {
  const id = useId();
  const t = useXT();
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <div className="relative">
        <Input id={id} type={visible ? "text" : "password"} className="pr-10" aria-invalid={error ? true : undefined} {...props} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
          aria-label={visible ? t("common.password_hide") : t("common.password_show")}
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </Field>
  );
}

export function Notice({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  const Icon = kind === "error" ? AlertCircle : kind === "success" ? CheckCircle : Info;
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-md border px-3 py-2 text-sm",
        kind === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        kind === "success" && "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
        kind === "info" && "border-border bg-muted text-foreground",
      )}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="min-h-dvh flex items-center justify-center text-sm text-muted-foreground" role="status">
      {label}
    </div>
  );
}
