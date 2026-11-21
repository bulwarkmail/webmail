"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { firstStrongDirection } from "@/lib/bidi";

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
  /**
   * Checks the trimmed value as it is typed. A message is shown under the
   * field and blocks submitting; null means the value is fine.
   */
  validate?: (value: string) => string | null;
  /** Select only the part before the last dot ("report" of "report.pdf"), for file names. */
  selectBaseName?: boolean;
  /** A third button at the start of the footer, e.g. "Remove link"; closes the dialog. */
  extraAction?: { label: string; onClick: () => void };
  /**
   * Fixed text after the field, such as a file's extension. It can't be
   * edited, `validate` sees it after the value, and `onSubmit` gets the
   * value alone: the caller adds it back.
   */
  suffix?: string;
}

/** The selection range for a name: all of it, or the part before the extension. */
export function nameSelectionRange(value: string, baseName: boolean): [number, number] {
  if (!baseName) return [0, value.length];
  const dot = value.lastIndexOf(".");
  // ".bashrc" has no extension to keep; "a." keeps nothing after its dot.
  return dot > 0 ? [0, dot] : [0, value.length];
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
  validate,
  selectBaseName = false,
  extraAction,
  suffix = "",
}: PromptDialogProps) {
  const t = useTranslations("confirm_dialog");
  const id = useId();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      const t = setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        const [start, end] = nameSelectionRange(input.value, selectBaseName);
        input.setSelectionRange(start, end);
      }, 50);
      return () => clearTimeout(t);
    }
  }, [isOpen, defaultValue, selectBaseName]);

  const resolvedConfirmText = confirmText || t("confirm");
  const resolvedCancelText = cancelText || t("cancel");
  const trimmed = value.trim();
  const error = trimmed.length > 0 && validate ? validate(trimmed + suffix) : null;
  const canSubmit = trimmed.length > 0 && !error;
  const errorId = `${id}-error`;

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
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={message}
      showClose={false}
      initialFocus={inputRef}
      onSubmit={handleSubmit}
      footer={
        <>
          {extraAction && (
            <Button
              type="button"
              variant="ghost"
              className="me-auto"
              onClick={() => {
                try {
                  extraAction.onClick();
                } finally {
                  onClose();
                }
              }}
            >
              {extraAction.label}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {resolvedCancelText}
          </Button>
          <Button type="submit" variant="default" disabled={!canSubmit}>
            {resolvedConfirmText}
          </Button>
        </>
      }
    >
      {/* With a suffix, the row runs the way the name reads, so an extension
          follows a Latin name on its right even in an RTL interface. */}
      <div className="mt-4 flex items-center gap-2" dir={suffix ? firstStrongDirection(value) ?? undefined : undefined} data-testid="prompt-row">
        <Input
          aria-label={title}
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn("min-w-0 flex-1", error && "border-destructive focus-visible:border-destructive")}
        />
        {suffix && (
          <span className="max-w-[50%] shrink-0 truncate text-sm text-muted-foreground" dir="auto" data-testid="prompt-suffix">
            {suffix}
          </span>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}
