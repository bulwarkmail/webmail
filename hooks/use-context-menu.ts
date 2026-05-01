"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";

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
const MENU_HEIGHT = 320; // Initial estimate; refined after mount via layout effect
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

  // Re-clamp position once we can measure the actual rendered menu — the
  // initial estimate uses a fixed height which can be too small for menus
  // with many items, causing the bottom to be clipped off-screen.
  useLayoutEffect(() => {
    if (!contextMenu.isOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = contextMenu.position.x;
    let y = contextMenu.position.y;

    if (x + rect.width > viewportWidth - VIEWPORT_MARGIN) {
      x = viewportWidth - rect.width - VIEWPORT_MARGIN;
    }
    if (y + rect.height > viewportHeight - VIEWPORT_MARGIN) {
      y = viewportHeight - rect.height - VIEWPORT_MARGIN;
    }
    x = Math.max(VIEWPORT_MARGIN, x);
    y = Math.max(VIEWPORT_MARGIN, y);

    if (x !== contextMenu.position.x || y !== contextMenu.position.y) {
      setContextMenu((prev) => ({ ...prev, position: { x, y } }));
    }
  }, [contextMenu.isOpen, contextMenu.position.x, contextMenu.position.y]);

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
