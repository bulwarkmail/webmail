"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { askInWindow, dialogWindowsAvailable } from "@/lib/desktop/dialog-window";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AlertTriangle } from "@/components/icons";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  /** Shown under the message, e.g. exactly what confirming will send. */
  details?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "destructive";
}

const noChanges = () => () => {};

interface WindowConfirm {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  variant: "default" | "destructive";
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Asks in a window of the app's own while `isOpen`, where the desktop shell can
 * (lib/desktop/dialog-window.ts). True while it does, so the caller draws nothing; false
 * in the browser, on an older shell, or once the shell refused, so the caller draws the
 * in-page dialog. Closing it from the page (isOpen false, unmount) takes the window back.
 */
export function useConfirmInWindow({ isOpen, title, message, confirmText, cancelText, variant, onConfirm, onClose }: WindowConfirm): boolean {
  const [refused, setRefused] = useState(false);
  const handlers = useRef({ onConfirm, onClose });
  useEffect(() => {
    handlers.current = { onConfirm, onClose };
  });
  const available = useSyncExternalStore(noChanges, dialogWindowsAvailable, () => false);
  const asking = isOpen && !refused && available;

  useEffect(() => {
    if (!asking) return;
    const destructive = variant === "destructive";
    const asked = askInWindow({
      title,
      message,
      ...(destructive ? { icon: "warning" as const } : {}),
      buttons: [
        { label: cancelText, variant: "secondary" },
        { label: confirmText, variant: destructive ? "destructive" : "primary" },
      ],
      // Enter says yes, except to something that can't be undone: there the focus starts on Cancel.
      defaultIndex: destructive ? 0 : 1,
    });
    if (!asked) return;
    let live = true;
    void asked.answer.then((answer) => {
      if (!live) return;
      live = false;
      if (answer === "failed") {
        setRefused(true);
        return;
      }
      if (answer && "button" in answer && answer.button === 1) {
        try {
          handlers.current.onConfirm();
        } finally {
          handlers.current.onClose();
        }
      } else {
        handlers.current.onClose();
      }
    });
    return () => {
      if (!live) return;
      live = false;
      asked.cancel();
    };
  }, [asking, title, message, confirmText, cancelText, variant]);

  // The next question tries the window again.
  useEffect(() => {
    if (!isOpen) setRefused(false);
  }, [isOpen]);

  return asking;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  details,
  confirmText,
  cancelText,
  variant = "default",
}: ConfirmDialogProps) {
  const t = useTranslations("confirm_dialog");

  const resolvedConfirmText = confirmText || t("confirm");
  const resolvedCancelText = cancelText || t("cancel");

  // In the desktop app a plain question (no rich details) gets a window of its own.
  const inWindow = useConfirmInWindow({
    isOpen: isOpen && details == null,
    title,
    message,
    confirmText: resolvedConfirmText,
    cancelText: resolvedCancelText,
    variant,
    onConfirm,
    onClose,
  });
  if (inWindow) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      role="alertdialog"
      title={title}
      description={message}
      showClose={false}
      icon={
        variant === "destructive" ? (
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
        ) : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {resolvedCancelText}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={() => {
              try {
                onConfirm();
              } finally {
                onClose();
              }
            }}
            className={cn(
              variant === "destructive" && "shadow-sm"
            )}
          >
            {resolvedConfirmText}
          </Button>
        </>
      }
    >
      {details}
    </Dialog>
  );
}
