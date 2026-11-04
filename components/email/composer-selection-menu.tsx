"use client";

// The right-click menu on selected text in the composer. It only appears
// when a plugin declared entries for it (the composer-selection-menu
// surface, api.ui.setActions); otherwise the browser's own menu stays, with
// its spelling suggestions. Cut and Copy are kept, since the menu replaces
// the one that had them. A click on a plugin entry carries the composer id
// and the selected text.
//
// It opens only for text the user had selected before the right-click.
// Chrome (a misspelled word, any word on a Mac) and Safari select the word
// under the pointer as the button goes down; that word belongs to the
// browser's menu and its spelling suggestions, not to ours. A right-click on
// a proofreading underline opens that issue's popup instead (the editor
// handles it first).

import { useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { PluginActions, usePluginActions } from "@/components/plugins/plugin-actions";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Copy, Scissors } from "@/components/icons";

export const COMPOSER_SELECTION_SURFACE = "composer-selection-menu";

export interface SelectionMenuTarget {
  /** The selected text, as the plugin gets it. */
  text: string;
}

/**
 * Where the menu opens for a contextmenu event. The keyboard (Shift+F10,
 * the Menu key) fires it at 0,0: then the menu opens under the selection.
 */
export function selectionMenuPoint(
  e: { clientX: number; clientY: number; currentTarget?: EventTarget | null },
  selection: Selection | null = typeof window === "undefined" ? null : window.getSelection(),
): { x: number; y: number } {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  if (selection && selection.rangeCount > 0) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width || rect.height) return { x: rect.left, y: rect.bottom };
  }
  const el = e.currentTarget instanceof Element ? e.currentTarget : null;
  const rect = el?.getBoundingClientRect();
  return rect ? { x: rect.left + 16, y: rect.top + 16 } : { x: 0, y: 0 };
}

/**
 * The selected text as the browser has it right now: ProseMirror's own
 * selection catches up only on the next selectionchange, after the
 * contextmenu event.
 */
export function liveSelectionText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  return window.getSelection()?.toString() ?? "";
}

/** The menu's state and the contextmenu handler for the message text. */
export function useComposerSelectionMenu() {
  const actions = usePluginActions(COMPOSER_SELECTION_SURFACE);
  const menu = useContextMenu<SelectionMenuTarget>();
  const { openContextMenu } = menu;
  const enabled = actions.length > 0;
  // The selection when the right button went down, before the browser moved it.
  const beforeRef = useRef<{ text: string; at: number } | null>(null);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return;
    beforeRef.current = { text: liveSelectionText(), at: Date.now() };
  }, []);
  const onContextMenu = useCallback((e: React.MouseEvent, read: () => string) => {
    if (!enabled || e.defaultPrevented) return;
    const text = read();
    if (!text.trim()) return;
    const before = beforeRef.current;
    beforeRef.current = null;
    // From the mouse: only when that selection was there already and the
    // press didn't change it. From the keyboard (Shift+F10, the Menu key)
    // there is no press, and the selection is the user's.
    const fromMouse = !!before && Date.now() - before.at < 2000;
    if (fromMouse && (!before.text.trim() || before.text !== liveSelectionText())) return;
    const point = selectionMenuPoint(e);
    openContextMenu({
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      clientX: point.x,
      clientY: point.y,
    } as React.MouseEvent, { text });
  }, [enabled, openContextMenu]);
  return { ...menu, onContextMenu, onMouseDown, enabled };
}

export function ComposerSelectionMenu({
  menu,
  composerId,
  onClipboard,
}: {
  menu: ReturnType<typeof useComposerSelectionMenu>;
  composerId: string | null;
  /** Cut or copy the selection the menu was opened on. */
  onClipboard: (command: "cut" | "copy") => void;
}) {
  const t = useTranslations("email_composer");
  const { contextMenu, closeContextMenu, menuRef } = menu;
  if (!contextMenu.isOpen) return null;
  const text = contextMenu.data?.text ?? "";
  return (
    <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
      <ContextMenuItem icon={Scissors} label={t("cut")} testId="composer-selection-cut" onClick={() => { closeContextMenu(); onClipboard("cut"); }} />
      <ContextMenuItem icon={Copy} label={t("copy")} testId="composer-selection-copy" onClick={() => { closeContextMenu(); onClipboard("copy"); }} />
      <ContextMenuSeparator />
      <PluginActions
        surface="composer-selection-menu"
        variant="menu"
        context={{ composerId, selection: { text } }}
        onRan={closeContextMenu}
      />
    </ContextMenu>
  );
}
