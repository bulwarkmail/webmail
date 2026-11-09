"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { ErrorState } from "@/components/error/error-fallbacks";
import { captureException } from "@/lib/error-reporting/client";

/**
 * Route-level error boundary for locale pages.
 * Catches errors in the locale layout and its children.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");

  useEffect(() => {
    console.error("Route error:", error);
    captureException(error, "boundary", false);
  }, [error]);

  return (
    <ErrorState
      className="min-h-screen"
      title={t("page_error_title")}
      description={t("page_error_description")}
      onRetry={reset}
      retryLabel={t("try_again")}
      homeLabel={t("go_home")}
    />
  );
}
