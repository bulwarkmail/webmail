"use client";

import { forwardRef, useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

interface Position {
  x: number;
  y: number;
}

interface ContextMenuProps {
  isOpen: boolean;
  position: Position;
  onClose: () => void;
  children: React.ReactNode;
}

const VIEWPORT_MARGIN = 10;

export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(
  ({ isOpen, position, onClose: _onClose, children }, ref) => {
    const [mounted, setMounted] = useState(false);
    const [adjustedPosition, setAdjustedPosition] = useState<Position | null>(null);
    const localRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      setMounted(true);
    }, []);

    // Measure the rendered menu and clamp it inside the viewport before the
    // browser paints. We hide the element until this runs so the user never
    // sees the menu jump from an unclamped position to a clamped one.
    useLayoutEffect(() => {
      if (!isOpen) {
        setAdjustedPosition(null);
        return;
      }
      const node = localRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let x = position.x;
      let y = position.y;

      if (x + rect.width > vw - VIEWPORT_MARGIN) {
        x = vw - rect.width - VIEWPORT_MARGIN;
      }
      if (y + rect.height > vh - VIEWPORT_MARGIN) {
        y = vh - rect.height - VIEWPORT_MARGIN;
      }
      x = Math.max(VIEWPORT_MARGIN, x);
      y = Math.max(VIEWPORT_MARGIN, y);

      setAdjustedPosition({ x, y });
    }, [isOpen, position.x, position.y]);

    const setRefs = (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    if (!mounted || !isOpen) return null;

    const renderPosition = adjustedPosition ?? position;
    const isPositioned = adjustedPosition !== null;

    return createPortal(
      <div
        ref={setRefs}
        className={cn(
          "fixed z-50 min-w-[200px] bg-background rounded-md shadow-lg border border-border"
        )}
        style={{
          left: renderPosition.x,
          top: renderPosition.y,
          visibility: isPositioned ? "visible" : "hidden",
        }}
        role="menu"
        aria-orientation="vertical"
      >
        <div className="py-1">
          {children}
        </div>
      </div>,
      document.body
    );
  }
);

ContextMenu.displayName = "ContextMenu";

interface ContextMenuItemProps {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
}

export function ContextMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  shortcut,
}: ContextMenuItemProps) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      className={cn(
        "w-full px-3 py-1.5 text-sm text-left flex items-center gap-2",
        "transition-colors duration-150",
        "focus:outline-none focus:bg-muted",
        disabled && "opacity-50 cursor-not-allowed",
        !disabled && "hover:bg-muted cursor-pointer",
        destructive && !disabled && "text-destructive hover:bg-destructive/10 focus:bg-destructive/10"
      )}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onClick();
      }}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-xs text-muted-foreground ml-auto">{shortcut}</span>
      )}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="h-px bg-border my-1" role="separator" />;
}

interface ContextMenuSubMenuProps {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}

export function ContextMenuSubMenu({
  icon: Icon,
  label,
  children,
}: ContextMenuSubMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [subMenuPos, setSubMenuPos] = useState<Position | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) {
      setSubMenuPos(null);
      return;
    }
    const itemEl = itemRef.current;
    const subEl = subMenuRef.current;
    if (!itemEl || !subEl) return;

    const itemRect = itemEl.getBoundingClientRect();
    const subRect = subEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left: number;
    if (itemRect.right + subRect.width <= vw - VIEWPORT_MARGIN) {
      left = itemRect.right;
    } else if (itemRect.left - subRect.width >= VIEWPORT_MARGIN) {
      left = itemRect.left - subRect.width;
    } else {
      left = Math.max(VIEWPORT_MARGIN, vw - subRect.width - VIEWPORT_MARGIN);
    }

    let top = itemRect.top;
    if (top + subRect.height > vh - VIEWPORT_MARGIN) {
      top = vh - subRect.height - VIEWPORT_MARGIN;
    }
    top = Math.max(VIEWPORT_MARGIN, top);

    setSubMenuPos({ x: left, y: top });
  }, [isOpen]);

  useEffect(() => {
    return () => clearTimeout(closeTimerRef.current ?? undefined);
  }, []);

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 150);
  };

  return (
    <div
      ref={itemRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          "w-full px-3 py-1.5 text-sm flex items-center gap-2",
          "transition-colors duration-150 cursor-pointer",
          "hover:bg-muted"
        )}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
        <span className="flex-1">{label}</span>
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>

      {isOpen && (
        <div
          ref={subMenuRef}
          className={cn(
            "fixed z-50 min-w-[180px] bg-background rounded-md shadow-lg border border-border",
            "animate-in fade-in-0 zoom-in-95 duration-100"
          )}
          style={{
            left: subMenuPos?.x ?? 0,
            top: subMenuPos?.y ?? 0,
            visibility: subMenuPos ? "visible" : "hidden",
          }}
          role="menu"
        >
          <div className="py-1 max-h-[min(300px,calc(100vh-40px))] overflow-y-auto">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

interface ContextMenuHeaderProps {
  children: React.ReactNode;
}

export function ContextMenuHeader({ children }: ContextMenuHeaderProps) {
  return (
    <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
      {children}
    </div>
  );
}
