"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

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
  const router = useRouter();

  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center max-w-md px-4">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          {t("page_error_title")}
        </h2>
        <p className="text-muted-foreground mb-6">
          {t("page_error_description")}
        </p>
        <div className="flex gap-3 justify-center">
          <Button variant="outline" onClick={() => router.push('/')}>
            <Home className="w-4 h-4 me-2" />
            {t("go_home")}
          </Button>
          <Button onClick={reset}>
            <RefreshCw className="w-4 h-4 me-2" />
            {t("try_again")}
          </Button>
        </div>
      </div>
    </div>
  );
}
