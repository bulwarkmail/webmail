"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface PromptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

export function PromptDialog({
  isOpen,
  onClose,
  onSubmit,
  title,
  message,
  placeholder,
  defaultValue = "",
  confirmText,
  cancelText,
}: PromptDialogProps) {
  const t = useTranslations("confirm_dialog");
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useFocusTrap({
    isActive: isOpen,
    onEscape: onClose,
    restoreFocus: true,
  });

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      return () => clearTimeout(t);
    }
  }, [isOpen, defaultValue]);

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
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    try {
      onSubmit(trimmed);
    } finally {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md animate-in zoom-in-95 duration-200"
      >
        <form onSubmit={handleSubmit}>
          <div className="p-6">
            <h2
              id={`${id}-title`}
              className="text-lg font-semibold text-foreground"
            >
              {title}
            </h2>
            {message && (
              <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            )}
            <Input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="mt-4"
            />
          </div>

          <div className="flex items-center justify-end gap-3 px-6 pb-6">
            <Button type="button" variant="outline" onClick={onClose}>
              {resolvedCancelText}
            </Button>
            <Button type="submit" variant="default" disabled={!canSubmit}>
              {resolvedConfirmText}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
