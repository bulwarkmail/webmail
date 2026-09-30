"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RenameDialogProps {
  currentName: string;
  title?: string;
  label?: string;
  onConfirm: (newName: string) => Promise<void>;
  onCancel: () => void;
  /** Returns an error message for a name the server would refuse. */
  validate?: (name: string) => string | null;
}

export function RenameDialog({ currentName, title, label, onConfirm, onCancel, validate }: RenameDialogProps) {
  const t = useTranslations("files");
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameError = name.trim() ? validate?.(name.trim()) ?? null : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || validate?.(trimmed)) return;

    setIsSubmitting(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-6 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">{title || t("rename_title")}</h2>
        <form onSubmit={handleSubmit}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={label || t("new_name")}
            className={nameError ? "mb-1" : "mb-4"}
            aria-invalid={!!nameError}
          />
          {nameError && <p className="text-xs text-destructive mb-3">{nameError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || !!nameError || isSubmitting}>
              {t("save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
