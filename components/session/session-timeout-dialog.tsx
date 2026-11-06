"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { Button } from "@/components/ui/button";
import { Clock, Loader2 } from "@/components/icons";
import type { SessionEndKind } from "@/lib/session-policy/session-timer";
import { ModalWindow } from "@/components/ui/dialog-surface";

interface SessionTimeoutDialogProps {
  /** 'ending': the session is over, drafts are being saved. */
  mode: SessionEndKind | 'ending';
  deadline: number | null;
  /** Hours of the maximum session length, for its message. */
  maxHours?: number;
  onStay: () => void;
  onDismiss: () => void;
  onSignOut: () => void;
}

function secondsLeft(deadline: number | null): number {
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** Screen readers hear the dialog when it opens, then only at these marks, not every second. */
const ANNOUNCE_AT = [30, 10];

/**
 * The warning before an organisation session limit signs the user out. For
 * the idle timeout it asks whether to stay; the maximum session length
 * can't be extended, so that one only says when it ends.
 */
export function SessionTimeoutDialog({ mode, deadline, maxHours, onStay, onDismiss, onSignOut }: SessionTimeoutDialogProps) {
  const t = useTranslations("session_limits");
  const id = useId();
  const [seconds, setSeconds] = useState(() => secondsLeft(deadline));
  const [announced, setAnnounced] = useState<number | null>(null);
  const dialogRef = useFocusTrap({
    isActive: true,
    onEscape: mode === "idle" ? onStay : mode === "max" ? onDismiss : undefined,
    restoreFocus: true,
  });

  useEffect(() => {
    setSeconds(secondsLeft(deadline));
    if (mode === "ending") return;
    const interval = setInterval(() => setSeconds(secondsLeft(deadline)), 250);
    return () => clearInterval(interval);
  }, [deadline, mode]);

  useEffect(() => {
    const mark = ANNOUNCE_AT.find((at) => seconds === at);
    if (mark !== undefined) setAnnounced(mark);
  }, [seconds]);

  if (typeof document === "undefined") return null;

  const title = mode === "max" ? t("max_title") : mode === "idle" ? t("idle_title") : t("signing_out");

  // Portalled to the end of the body above everything else, the office
  // editor (z-100) and plugin dialogs (z-100000) included.
  return createPortal(
    <ModalWindow title={title} onClose={mode === "idle" ? onStay : mode === "max" ? onDismiss : () => {}}>
      <div data-modal-backdrop="" className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]" data-testid="session-timeout-dialog">
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          aria-describedby={mode !== "ending" ? `${id}-message` : undefined}
          className="w-full max-w-md rounded-lg border border-border bg-background shadow-xl"
        >
          <div className="flex items-start gap-4 p-6">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {mode === "ending" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Clock className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">{title}</h2>
              {mode !== "ending" && (
                <p id={`${id}-message`} className="mt-2 text-sm text-muted-foreground">
                  {mode === "max"
                    ? t("max_message", { hours: maxHours ?? 0, seconds })
                    : t("idle_message", { seconds })}
                </p>
              )}
              <span className="sr-only" aria-live="polite">
                {mode !== "ending" && announced !== null ? t("seconds_left", { seconds: announced }) : ""}
              </span>
            </div>
          </div>
          {mode !== "ending" && (
            // The safe answer comes first, so the focus trap starts on it and
            // Enter keeps the user signed in; row-reverse shows it on the right.
            <div className="flex flex-row-reverse flex-wrap items-center justify-start gap-3 px-6 pb-6">
              {mode === "idle"
                ? <Button onClick={onStay}>{t("stay")}</Button>
                : <Button onClick={onDismiss}>{t("dismiss")}</Button>}
              <Button variant="outline" onClick={onSignOut}>{t("sign_out_now")}</Button>
            </div>
          )}
        </div>
      </div>
    </ModalWindow>,
    document.body,
  );
}
