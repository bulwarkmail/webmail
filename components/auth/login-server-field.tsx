"use client";

import { forwardRef, useId } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { AlertCircle, Loader2 } from "@/components/icons";
import { apiFetch } from "@/lib/browser-navigation";
import { serverHostLabel } from "@/lib/auth/mail-server-address";

/** Asks this app's server which mail server an address belongs to. Null when nothing was found. */
export async function requestServerDiscovery(email: string): Promise<string | null> {
  try {
    const res = await apiFetch("/api/auth/discover-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { serverUrl?: unknown } | null;
    return typeof body?.serverUrl === "string" && body.serverUrl ? body.serverUrl : null;
  } catch {
    return null;
  }
}

export type ServerLookup = "idle" | "looking" | "found" | "failed";
export type ServerFieldError = "needed" | "invalid" | null;

interface LoginServerFieldProps {
  lookup: ServerLookup;
  /** The server in use when the field is closed: found, or the admin's default. */
  server: string | null;
  /** The field is open: nothing was found, or the user chose to change it. */
  editing: boolean;
  value: string;
  onChange: (value: string) => void;
  onEdit: () => void;
  /** A provider Bulwark can't reach (Gmail, Outlook.com, iCloud Mail), by name. */
  provider: string | null;
  error: ServerFieldError;
  /** The browser's CORS hint, behind "Having trouble?". Not in the desktop app, which has no website to allow. */
  showTrouble: boolean;
  disabled?: boolean;
}

/**
 * The mail server part of the sign-in form when people may name a server of their
 * own. It comes after the email address: the server is looked up from it, and the
 * field only opens when nothing was found or the user wants another one.
 */
export const LoginServerField = forwardRef<HTMLInputElement, LoginServerFieldProps>(function LoginServerField(
  { lookup, server, editing, value, onChange, onEdit, provider, error, showTrouble, disabled },
  ref,
) {
  const t = useTranslations("uxs_login");
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const providerNote = provider && (
    <div role="status" data-testid="login-provider-unsupported" className="p-3 rounded-xl border border-warning/30 bg-warning/5 flex items-start gap-2.5 text-sm text-foreground leading-relaxed">
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" />
      <span>{t("provider_unsupported", { provider })}</span>
    </div>
  );

  if (!editing) {
    if (lookup === "looking") {
      return (
        <p role="status" data-testid="login-server-looking" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          {t("server_looking")}
        </p>
      );
    }
    if (server) {
      return (
        <div className="space-y-3">
          {providerNote}
          <p data-testid="login-server-found" className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span className="truncate">{t("server_found", { server: serverHostLabel(server) })}</span>
            <button
              type="button"
              onClick={onEdit}
              disabled={disabled}
              className="underline hover:text-foreground flex-shrink-0"
              data-testid="login-server-change"
            >
              {t("server_change")}
            </button>
          </p>
        </div>
      );
    }
    return providerNote || null;
  }

  return (
    <div className="space-y-3">
      {providerNote}
      <div className="space-y-1.5">
        <label htmlFor="jmap-endpoint" className="block text-sm font-medium text-foreground">
          {t("server_label")}
        </label>
        <Input
          ref={ref}
          id="jmap-endpoint"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
          placeholder={t("server_placeholder")}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errorId : null, lookup === "failed" && !provider ? hintId : null].filter(Boolean).join(" ") || undefined}
        />
        {lookup === "failed" && !provider && !error && (
          <p id={hintId} className="text-xs text-muted-foreground leading-snug" data-testid="login-server-not-found">
            {t("server_not_found")}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-xs text-destructive leading-snug" data-testid="login-server-error">
            {error === "invalid" ? t("server_invalid") : t("server_needed")}
          </p>
        )}
        {showTrouble && (
          <details className="text-xs text-muted-foreground" data-testid="login-server-trouble">
            <summary className="cursor-pointer hover:text-foreground w-fit">{t("trouble")}</summary>
            <p className="mt-1.5 leading-snug">{t("trouble_cors")}</p>
          </details>
        )}
      </div>
    </div>
  );
});
