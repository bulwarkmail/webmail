"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ContextMenuPosition } from "@/components/ui/context-menu";
import { nativeMenuIsOpen } from "@/lib/desktop/native-menu";

interface ContextMenuState<T> {
  isOpen: boolean;
  position: ContextMenuPosition;
  data: T | null;
}

export interface UseContextMenuReturn<T> {
  contextMenu: ContextMenuState<T>;
  /**
   * Open from a contextmenu or click event. Opened by keyboard (a click
   * from Enter/Space, or Shift+F10 / the Menu key) it anchors to the
   * element the handler sits on instead of the pointer.
   */
  openContextMenu: (e: React.MouseEvent, data: T) => void;
  /** Open under an element, e.g. a ⋮ button: lined up with its start or end edge. */
  openContextMenuFrom: (element: HTMLElement, data: T, align?: "start" | "end") => void;
  closeContextMenu: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}

/** Shift+F10 or the Menu key: open the focused element's context menu. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
}

/** Whether a mouse event came from the keyboard rather than a pointer. */
function openedByKeyboard(e: React.MouseEvent): boolean {
  if (e.type === "click") return e.detail === 0;
  // Shift+F10 and the Menu key fire contextmenu at 0,0 (or without a point).
  if (e.type === "contextmenu") return !e.clientX && !e.clientY;
  return false;
}

/**
 * Where the focus goes back to when the menu closes: the control inside the
 * opener that had it (a folder row's button, a message row's checkbox, where
 * Shift+F10 was pressed), else the opener itself.
 */
function focusReturnTarget(opener: HTMLElement): HTMLElement {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && opener.contains(active) ? active : opener;
}

/** The position that opens a menu under an element. */
export function anchorPosition(element: HTMLElement, align: "start" | "end" = "start"): ContextMenuPosition {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.bottom,
    anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, align },
    trigger: element,
  };
}

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [contextMenu, setContextMenu] = useState<ContextMenuState<T>>({
    isOpen: false,
    position: { x: 0, y: 0 },
    data: null,
  });

  const menuRef = useRef<HTMLDivElement | null>(null);

  const openContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault();
    e.stopPropagation();

    const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    const trigger = target ? focusReturnTarget(target) : null;
    const position: ContextMenuPosition = target && openedByKeyboard(e)
      ? { ...anchorPosition(target), trigger }
      // At the pointer as it is: the menu places itself once it knows its size,
      // opening up or to the side where there's no room (lib/menu-placement.ts).
      : { x: e.clientX, y: e.clientY, trigger, fromPointer: true };
    // The row it's for stays marked while it's open (a ⋮ inside the row counts as the row).
    if (target) position.opener = target.closest<HTMLElement>("[data-menu-row]") ?? target;

    setContextMenu({
      isOpen: true,
      position,
      data,
    });
  }, []);

  const openContextMenuFrom = useCallback((element: HTMLElement, data: T, align: "start" | "end" = "start") => {
    setContextMenu({ isOpen: true, position: anchorPosition(element, align), data });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  // Close on escape key, click outside, and scroll. (ContextMenu answers
  // Escape itself and keeps it from the app; this one is a fallback.)
  useEffect(() => {
    if (!contextMenu.isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeContextMenu();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (nativeMenuIsOpen()) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    const handleScroll = (e: Event) => {
      if (nativeMenuIsOpen()) return;
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      closeContextMenu();
    };

    const handleBlur = () => {
      // A focused control in the menu may have opened a system dialog that
      // took the focus from the window, such as a color input's (#1366).
      if (menuRef.current?.contains(document.activeElement)) return;
      // In the desktop app the menu is native: it closes itself, and says what was picked.
      if (nativeMenuIsOpen()) return;
      closeContextMenu();
    };

    // Add listeners with a slight delay to prevent immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener("keydown", handleEscape);
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("scroll", handleScroll, true);
      window.addEventListener("blur", handleBlur);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [contextMenu.isOpen, closeContextMenu]);

  return {
    contextMenu,
    openContextMenu,
    openContextMenuFrom,
    closeContextMenu,
    menuRef,
  };
}
