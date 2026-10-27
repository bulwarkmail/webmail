"use client";

import { forwardRef, useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { ChevronRight } from "@/components/icons";

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
    // `mounted` must be a dependency: on the very first open the menu isn't
    // in the DOM yet (mounted is still false), so this effect has to re-run
    // after the mount flip or the menu stays visibility:hidden.
    //
    // The menu can grow after it opened (a plugin frame in it reports its
    // height later), so it is clamped again whenever its size changes.
    useLayoutEffect(() => {
      if (!isOpen) {
        setAdjustedPosition(null);
        return;
      }
      const node = localRef.current;
      if (!node) return;

      const clamp = () => {
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

        setAdjustedPosition((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
      };
      clamp();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(clamp);
      observer.observe(node);
      return () => observer.disconnect();
    }, [isOpen, mounted, position.x, position.y]);

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
        {/* Taller than the window: scroll inside the menu. */}
        <div className="py-1 overflow-y-auto" style={{ maxHeight: `calc(100vh - ${2 * VIEWPORT_MARGIN + 2}px)` }}>
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
  /** Stable hook for integration tests (not user-visible). */
  testId?: string;
  /** Tooltip, e.g. the address behind a display name. */
  title?: string;
  /** A second line under the label, e.g. why the item is disabled. */
  hint?: string;
}

export function ContextMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  shortcut,
  testId,
  title,
  hint,
}: ContextMenuItemProps) {
  return (
    <button
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      title={title}
      className={cn(
        "w-full px-3 py-1.5 text-sm text-start flex items-center gap-2",
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
      {hint ? (
        <span className="flex-1 min-w-0">
          <span className="block">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      ) : (
        <span className="flex-1">{label}</span>
      )}
      {shortcut && (
        <span className="text-xs text-muted-foreground ms-auto">{shortcut}</span>
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
  /** Stable hook for integration tests (not user-visible). */
  testId?: string;
  /** Shown but not openable. */
  disabled?: boolean;
  /** Tooltip on the entry. */
  title?: string;
  /** A second line under the label, e.g. why the entry is disabled. */
  hint?: string;
}

export function ContextMenuSubMenu({
  icon: Icon,
  label,
  children,
  testId,
  disabled = false,
  title,
  hint,
}: ContextMenuSubMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => clearTimeout(closeTimerRef.current ?? undefined);
  }, []);

  const handleMouseEnter = () => {
    if (disabled) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      // A control in the submenu that has the focus may have opened a system
      // dialog (a color input): closing would drop its answer (#1366).
      if (rootRef.current?.contains(document.activeElement)) return;
      setIsOpen(false);
    }, 150);
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          "w-full px-3 py-1.5 text-sm flex items-center gap-2",
          "transition-colors duration-150",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted"
        )}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        title={title}
      >
        {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
        {hint ? (
          <span className="flex-1 min-w-0">
            <span className="block">{label}</span>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </span>
        ) : (
          <span className="flex-1">{label}</span>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>

      {isOpen && !disabled && (
        <SubMenuPanel
          className="min-w-[180px] bg-background rounded-md shadow-lg border border-border"
          role="menu"
        >
          <div className="py-1 max-h-[min(300px,calc(100vh-40px))] overflow-y-auto">
            {children}
          </div>
        </SubMenuPanel>
      )}
    </div>
  );
}

interface SubMenuPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The side of the entry to open on when it fits; flips with the text direction. */
  side?: "start" | "end";
}

/**
 * A submenu's panel, placed beside the entry it is rendered in (its parent
 * element): on `side` when it fits in the window, else on the other side,
 * else clamped inside the window. It is `position: fixed`, so a pane that
 * clips its overflow can't cut it off.
 */
export function SubMenuPanel({ side = "end", className, style, ...rest }: SubMenuPanelProps) {
  const [pos, setPos] = useState<Position | null>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const subEl = subMenuRef.current;
    const itemEl = subEl?.parentElement;
    if (!subEl || !itemEl) return;

    const itemRect = itemEl.getBoundingClientRect();
    const subRect = subEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Where the panel's left edge goes on either side, if it fits there.
    const onRight = itemRect.right + subRect.width <= vw - VIEWPORT_MARGIN ? itemRect.right : null;
    const onLeft = itemRect.left - subRect.width >= VIEWPORT_MARGIN ? itemRect.left - subRect.width : null;
    const rightFirst = (side === "end") !== (getComputedStyle(itemEl).direction === "rtl");
    const x = (rightFirst ? (onRight ?? onLeft) : (onLeft ?? onRight))
      ?? Math.max(VIEWPORT_MARGIN, vw - subRect.width - VIEWPORT_MARGIN);

    let top = itemRect.top;
    if (top + subRect.height > vh - VIEWPORT_MARGIN) {
      top = vh - subRect.height - VIEWPORT_MARGIN;
    }
    top = Math.max(VIEWPORT_MARGIN, top);

    // The submenu is measured while it still sits at left/top 0, so its rect
    // is the origin `position: fixed` resolves against. That is the viewport,
    // unless a theme gives the parent menu a backdrop-filter, filter or
    // transform: then the parent is the containing block and viewport
    // coordinates land offset by the parent's own position, far from the
    // entry (#1149).
    setPos({ x: x - subRect.left, y: top - subRect.top });
  }, [side]);

  return (
    <div
      {...rest}
      ref={subMenuRef}
      className={cn("fixed z-50", className)}
      style={{
        ...style,
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    />
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
