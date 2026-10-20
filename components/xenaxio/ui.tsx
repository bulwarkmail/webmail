"use client";

// Building blocks of the xenaxio pages, styled with the client's theme tokens.
import { useId, useState, type ReactNode } from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { AlertCircle, CheckCircle, Eye, EyeOff, Info } from "@/components/icons";
import { useConfig } from "@/hooks/use-config";
import { withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";

/** Centered card for sign-in, password and onboarding pages. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const t = useXT();
  // Brand logo from config.json (W1); no default, so no other product's logo flashes.
  const { appLogoLightUrl } = useConfig();
  return (
    <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2">
          {appLogoLightUrl && <img src={withBasePath(appLogoLightUrl)} alt="" className="h-14 w-14" />}
          <p className="text-center text-sm font-semibold tracking-wide text-primary">{t("common.app_name")}</p>
        </div>
        <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm p-6 sm:p-8">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
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
