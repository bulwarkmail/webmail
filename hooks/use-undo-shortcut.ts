"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { isEditableEventTarget, shortcutKey } from "@/lib/keyboard";
import { clearUndoHistory, undoLatest } from "@/lib/undo-history";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";

/**
 * Whether a key press asks to undo: Ctrl+Z (⌘Z) outside text fields, or `z`
 * alone while single-key shortcuts are on. Never while a modal dialog is
 * open or while typing, where the keys belong to the dialog or the field.
 */
export function isUndoKey(e: KeyboardEvent, singleKeyShortcuts: boolean): boolean {
  if (e.defaultPrevented || e.repeat) return false;
  // The Z the key types, or the Z place on a non-Latin layout.
  const isZ = shortcutKey(e) === "z";
  if (!isZ || e.altKey || e.shiftKey) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && !singleKeyShortcuts) return false;
  if (isEditableEventTarget(e)) return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  return true;
}

/**
 * Undo from the keyboard in Mail: the newest action in the undo history
 * (lib/undo-history) is put back, then the one before it, and so on.
 */
export function useUndoShortcut({ enabled, signedIn }: { enabled: boolean; signedIn: boolean }) {
  const t = useTranslations("notifications");

  useEffect(() => {
    if (!signedIn) clearUndoHistory();
  }, [signedIn]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isUndoKey(e, useSettingsStore.getState().singleKeyShortcuts)) return;
      e.preventDefault();
      if (!undoLatest()) toast.info(t("nothing_to_undo"));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, t]);
}
