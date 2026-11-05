"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { CloudOff, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useConnectionState } from "@/hooks/use-connection-state";

/** Two signals for one return (the browser's online event and the app's state): one retry. */
const RETRY_GAP_MS = 1000;

/**
 * The reading pane when a message couldn't be fetched: offline (in a browser
 * that keeps no mail on the device), or another failure. A short line and
 * Retry, instead of an empty pane that says nothing.
 *
 * Offline, it tries again by itself once the connection is back: the
 * browser's online event, or the app's own connection state turning online
 * (the mail server reachable again). The offline bar went away while the
 * pane still said "You're offline" (mail-p3-2).
 */
export function ReaderOpenFailure({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  const t = useTranslations("mail_p2_desk");
  const { offline: connectionOffline } = useConnectionState();
  const retryRef = useRef(onRetry);
  const lastRetry = useRef(0);
  const sawOffline = useRef(connectionOffline);
  useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);

  useEffect(() => {
    if (!offline) return;
    const retry = () => {
      if (Date.now() - lastRetry.current < RETRY_GAP_MS) return;
      lastRetry.current = Date.now();
      retryRef.current();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [offline]);

  useEffect(() => {
    if (!offline) return;
    // Only a change from offline to online: a pane shown while the app thinks
    // it's online would otherwise retry in a loop.
    if (sawOffline.current && !connectionOffline && Date.now() - lastRetry.current >= RETRY_GAP_MS) {
      lastRetry.current = Date.now();
      retryRef.current();
    }
    sawOffline.current = connectionOffline;
  }, [offline, connectionOffline]);

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
