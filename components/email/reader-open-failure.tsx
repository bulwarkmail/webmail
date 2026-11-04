"use client";

import { useTranslations } from "next-intl";
import { CloudOff, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * The reading pane when a message couldn't be fetched: offline (in a browser
 * that keeps no mail on the device), or another failure. A short line and
 * Retry, instead of an empty pane that says nothing.
 */
export function ReaderOpenFailure({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  const t = useTranslations("mail_p2_desk");
  return (
    <div role="status" data-reader-open-failure={offline ? "offline" : "failed"} className="m-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center">
      <CloudOff className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-foreground">{t(offline ? "reader_offline" : "reader_failed")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" />
        {t("retry")}
      </Button>
    </div>
  );
}
