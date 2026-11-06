"use client";

import { lazyComponent } from "@/lib/lazy-component";
import type { ComponentProps } from "react";
import type { KeyboardShortcutsModal as Modal } from "@/components/keyboard-shortcuts-modal";

const KeyboardShortcutsModal = lazyComponent(
  () => import("@/components/keyboard-shortcuts-modal").then((m) => m.KeyboardShortcutsModal),
);

/**
 * The keyboard shortcuts help, its code fetched the first time it opens instead
 * of with the page. Closed it draws nothing, as the dialog itself does, and it
 * opens on the current app each time either way.
 */
export function LazyKeyboardShortcutsModal(props: ComponentProps<typeof Modal>) {
  return props.isOpen ? <KeyboardShortcutsModal {...props} /> : null;
}
