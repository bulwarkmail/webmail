"use client";

// Step 44: the connection test of a company's own model, point by point.
import { useLocale } from "next-intl";
import { Check, X } from "@/components/icons";
import type { CustomModelCheck } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

function CheckLine({ ok, warn, label, hint }: { ok: boolean; warn?: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
      ) : (
        <X className={cn("mt-0.5 h-4 w-4 shrink-0", warn ? "text-amber-600 dark:text-amber-400" : "text-destructive")} aria-hidden />
      )}
      <span>
        {label}
        {!ok && hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

export function CustomModelCheckResult({ check, model }: { check: CustomModelCheck; model: string }) {
  const t = useXT();
  const locale = useLocale();
  const status = check.status ?? "";
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className={cn("text-sm font-medium", check.ok ? "text-green-700 dark:text-green-400" : "text-destructive")}>
        {check.ok ? t("aiadmin.check_ok") : t("aiadmin.check_failed")}
      </p>
      {check.error && <p className="text-sm">{t(`aiadmin.check_error_${check.error}`, { status })}</p>}
      <ul className="space-y-1">
        <CheckLine ok={check.stream} label={t("aiadmin.check_stream")} />
        <CheckLine ok={check.tools} label={t("aiadmin.check_tools")} hint={check.stream ? t("aiadmin.check_tools_hint") : undefined} />
        <CheckLine ok={check.usage} warn label={t("aiadmin.check_usage")} hint={check.stream ? t("aiadmin.check_usage_hint") : undefined} />
      </ul>
      {check.models && check.models.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("aiadmin.check_models", { models: check.models.slice(0, 10).join(", ") })}
          {!check.models.includes(model) && <> {t("aiadmin.check_model_missing", { model })}</>}
        </p>
      )}
      {check.firstTokenMs !== null && <p className="text-xs text-muted-foreground">{t("aiadmin.check_first_token", { seconds: (check.firstTokenMs / 1000).toLocaleString(locale, { maximumFractionDigits: 1 }) })}</p>}
    </div>
  );
}
