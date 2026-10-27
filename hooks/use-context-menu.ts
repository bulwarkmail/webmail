"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface Position {
  x: number;
  y: number;
}

interface ContextMenuState<T> {
  isOpen: boolean;
  position: Position;
  data: T | null;
}

interface UseContextMenuReturn<T> {
  contextMenu: ContextMenuState<T>;
  openContextMenu: (e: React.MouseEvent, data: T) => void;
  closeContextMenu: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}

const MENU_WIDTH = 200;
const MENU_HEIGHT = 320; // Approximate max height
const VIEWPORT_MARGIN = 10;

export function useContextMenu<T>(): UseContextMenuReturn<T> {
  const [contextMenu, setContextMenu] = useState<ContextMenuState<T>>({
    isOpen: false,
    position: { x: 0, y: 0 },
    data: null,
  });

  const menuRef = useRef<HTMLDivElement | null>(null);

  const calculatePosition = useCallback((clientX: number, clientY: number): Position => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = clientX;
    let y = clientY;

    // Adjust for right edge
    if (x + MENU_WIDTH > viewportWidth - VIEWPORT_MARGIN) {
      x = viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN;
    }

    // Adjust for bottom edge
    if (y + MENU_HEIGHT > viewportHeight - VIEWPORT_MARGIN) {
      y = viewportHeight - MENU_HEIGHT - VIEWPORT_MARGIN;
    }

    // Ensure minimum position
    x = Math.max(VIEWPORT_MARGIN, x);
    y = Math.max(VIEWPORT_MARGIN, y);

    return { x, y };
  }, []);

  const openContextMenu = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault();
    e.stopPropagation();

    const position = calculatePosition(e.clientX, e.clientY);

    setContextMenu({
      isOpen: true,
      position,
      data,
    });
  }, [calculatePosition]);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  // Close on escape key, click outside, and scroll
  useEffect(() => {
    if (!contextMenu.isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeContextMenu();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      closeContextMenu();
    };

    const handleBlur = () => {
      // A focused control in the menu may have opened a system dialog that
      // took the focus from the window, such as a color input's (#1366).
      if (menuRef.current?.contains(document.activeElement)) return;
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
    closeContextMenu,
    menuRef,
  };
}
