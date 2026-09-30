"use client";

import { useEffect, useId } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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
  const id = useId();

  const dialogRef = useFocusTrap({
    isActive: isOpen,
    onEscape: onClose,
    restoreFocus: true,
  });

  useEffect(() => {
    if (!isOpen) return;

    const handleBackdropClick = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleBackdropClick);
    return () => document.removeEventListener("mousedown", handleBackdropClick);
  }, [isOpen, onClose, dialogRef]);

  if (!isOpen) return null;

  const resolvedConfirmText = confirmText || t("confirm");
  const resolvedCancelText = cancelText || t("cancel");

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md animate-in zoom-in-95 duration-200"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            {variant === "destructive" && (
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-destructive" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2
                id={`${id}-title`}
                className="text-lg font-semibold text-foreground"
              >
                {title}
              </h2>
              <p
                id={`${id}-message`}
                className="mt-2 text-sm text-muted-foreground"
              >
                {message}
              </p>
              {details}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 pb-6">
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
        </div>
      </div>
    </div>
  );
}
