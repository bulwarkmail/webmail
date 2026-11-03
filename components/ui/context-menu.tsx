"use client";

import { hoverOpens } from "@/lib/open-on-hover";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { ChevronRight } from "@/components/icons";
import { useTranslations } from "next-intl";
import { nativeMenusAvailable, readSettledMenu, showNativeMenu } from "@/lib/desktop/native-menu";
import { toast } from "@/stores/toast-store";

interface Position {
  x: number;
  y: number;
}

/** The element a menu opened from, in viewport coordinates. */
export interface ContextMenuAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Line the menu up with the anchor's start (default) or end edge; flips in RTL. */
  align?: "start" | "end";
}

export interface ContextMenuPosition extends Position {
  /** Opened from a button or by keyboard: placed under (or over) this rect instead of at x/y. */
  anchor?: ContextMenuAnchor;
  /** Gets the focus back when the menu closes. Default: what had the focus when it opened. */
  trigger?: HTMLElement | null;
}

interface ContextMenuProps {
  isOpen: boolean;
  position: ContextMenuPosition;
  onClose: () => void;
  children: React.ReactNode;
  /** The menu's accessible name, e.g. the label of the ⋮ button that opens it. */
  label?: string;
}

const VIEWPORT_MARGIN = 10;
const ANCHOR_GAP = 4;
const HOVER_CLOSE_DELAY = 150;

// ─── Which menu is open ────────────────────────────────────────

// Open menus, the one opened last at the end. Only that one answers keys.
const openMenus: object[] = [];

const openListeners = new Set<() => void>();

function syncOpenFlag() {
  if (typeof document === "undefined") return;
  if (openMenus.length > 0) document.documentElement.dataset.contextMenuOpen = "";
  else delete document.documentElement.dataset.contextMenuOpen;
  for (const listener of openListeners) listener();
}

/**
 * True while a ContextMenu is open. App shortcut hooks check it (or the
 * `data-context-menu-open` attribute on <html>) and stand down: the menu
 * owns the keyboard until it closes.
 */
export function isContextMenuOpen(): boolean {
  return openMenus.length > 0;
}

function subscribeContextMenuOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

/** isContextMenuOpen as state: re-renders when a menu opens or the last one closes. */
export function useContextMenuOpen(): boolean {
  return useSyncExternalStore(subscribeContextMenuOpen, isContextMenuOpen, () => false);
}

// ─── Items of a menu level ─────────────────────────────────────

const ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  "button",
  "a[href]",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isUsable(level: HTMLElement, el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false;
  if (typeof window.getComputedStyle !== "function") return true;
  // Only display: a menu that just turned visible can still compute as
  // hidden for a frame (under reduced motion every property transitions).
  for (let node: HTMLElement | null = el; node && node !== level; node = node.parentElement) {
    if (window.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** The controls of one menu level, in order: not those of a submenu inside it. */
export function menuLevelItems(level: HTMLElement): HTMLElement[] {
  const all = Array.from(level.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (el) => el.closest('[role="menu"]') === level
  );
  // A control inside a menu item (a plugin entry's button) is not a stop of its own.
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)) && isUsable(level, el));
}

/** Single-line text fields keep ←/→/Home/End; ↑/↓ still move through the menu. */
function isSingleLineText(el: Element): boolean {
  return el instanceof HTMLInputElement && /^(text|search|email|url|tel|password|)$/.test(el.type);
}

/** Fields that need every key but Escape and Tab. */
function needsKeys(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el instanceof HTMLInputElement && !isSingleLineText(el) && !/^(button|submit|reset|checkbox|radio|color|file|image)$/.test(el.type);
}

function focusEl(el: HTMLElement | undefined | null) {
  el?.focus({ preventScroll: true });
}

/**
 * Focus the first item of a menu level once it can take the focus: entries
 * can render a moment after the menu (the mail menu waits for its data), and
 * a panel that just turned visible can count as hidden for a frame. Gives
 * up when the focus goes somewhere else meanwhile. Returns a cancel.
 */
function focusFirstItem(level: HTMLElement): () => void {
  const from = document.activeElement;
  let frame = 0;
  let tries = 0;
  let done = false;
  const attempt = () => {
    if (done) return;
    const active = document.activeElement;
    if ((active && level.contains(active)) || active !== from) {
      done = true;
      return;
    }
    const first = menuLevelItems(level)[0];
    focusEl(first);
    if (first && document.activeElement === first) {
      done = true;
      return;
    }
    if (++tries < 30) frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    done = true;
    cancelAnimationFrame(frame);
  };
}

// Events the menu sends to a submenu's entry.
const SUBMENU_OPEN = "contextmenu:submenu-open";
const SUBMENU_CLOSE = "contextmenu:submenu-close";

function submenuTriggerOf(el: Element | null): HTMLElement | null {
  return el instanceof HTMLElement && el.dataset.submenuTrigger !== undefined ? el : null;
}

/** Close the submenu whose panel this is and put the focus on its entry. */
function closeSubmenuPanel(panel: HTMLElement) {
  const trigger = panel.parentElement?.querySelector<HTMLElement>(":scope > [data-submenu-trigger]");
  trigger?.dispatchEvent(new CustomEvent(SUBMENU_CLOSE));
}

// ─── Hover and open state of one level ─────────────────────────

interface MenuLevel {
  /** The submenu of this level that is open. */
  openId: string | null;
  /** Open a submenu (or close them all with null), after `delay` ms unless asked again. */
  request: (id: string | null, delay?: number) => void;
  /** A touch happened just now: the mouse events that follow are emulated. */
  recentTouch: () => boolean;
}

const MenuLevelContext = createContext<MenuLevel | null>(null);
const neverTouched = () => false;

/** The desktop app shows this menu natively: it renders hidden, submenus and all, to be read. */
const NativeMenuContext = createContext(false);

function useMenuLevel(recentTouch: () => boolean): MenuLevel {
  const [openId, setOpenId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const request = useCallback((id: string | null, delay = 0) => {
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    if (delay <= 0) {
      setOpenId(id);
      return;
    }
    timer.current = setTimeout(() => {
      // A field in the open submenu has the focus, e.g. a color input whose
      // system dialog is up: closing would drop its answer (#1366).
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.closest("[data-submenu-panel]")) return;
      setOpenId(id);
    }, delay);
  }, []);
  return useMemo(() => ({ openId, request, recentTouch }), [openId, request, recentTouch]);
}

// ─── The menu ──────────────────────────────────────────────────

/**
 * A menu in a portal: right-click menus, ⋮ menus, popover menus (R6).
 *
 * Keyboard: the focus moves to the first item on open; ↑/↓/Home/End move,
 * Enter/Space activate, → (← in RTL) or Enter opens a submenu, ← or Escape
 * closes it; Escape and Tab close the menu and give the focus back to the
 * element it opened from. While it is open it owns the keyboard: keys don't
 * reach the app's shortcut handlers.
 */
export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(
  ({ isOpen, position, onClose, children, label }, ref) => {
    const [mounted, setMounted] = useState(false);
    const [adjustedPosition, setAdjustedPosition] = useState<Position | null>(null);
    const localRef = useRef<HTMLDivElement | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
      onCloseRef.current = onClose;
    });
    const lastTouchAt = useRef(0);
    const recentTouch = useCallback(() => Date.now() - lastTouchAt.current < 800, []);
    const level = useMenuLevel(recentTouch);
    const { request: requestLevel } = level;
    const [nativeRefused, setNativeRefused] = useState(false);
    const nativeMode = isOpen && mounted && !nativeRefused && nativeMenusAvailable();
    const positionRef = useRef(position);
    positionRef.current = position;
    const tDesktop = useTranslations("desktopUi.menu");
    const tDesktopRef = useRef(tDesktop);
    tDesktopRef.current = tDesktop;

    useEffect(() => {
      setMounted(true);
    }, []);

    useEffect(() => {
      if (!isOpen) setNativeRefused(false);
    }, [isOpen]);

    // In the desktop app: read what rendered and show that natively. See lib/desktop/native-menu.ts.
    useEffect(() => {
      if (!nativeMode) return;
      const root = localRef.current;
      if (!root) return;
      let cancelled = false;
      void (async () => {
        const read = await readSettledMenu(root, () => cancelled);
        if (cancelled) return;
        if (read.unsupported) {
          setNativeRefused(true);
          return;
        }
        const { anchor: at } = positionRef.current;
        // From a right-click it opens at the pointer, which the OS knows best.
        const place = at
          ? { x: at.align === "end" ? Math.max(0, at.right - root.getBoundingClientRect().width) : at.left, y: at.bottom + ANCHOR_GAP }
          : undefined;
        const outcome = await showNativeMenu(read, root, place, tDesktopRef.current("from_plugins"));
        if (cancelled) return;
        // "More from plugins": the menu itself, with what only it can show.
        if (outcome === "html") {
          setNativeRefused(true);
          return;
        }
        if (outcome === "gone") toast.warning(tDesktopRef.current("pick_gone"));
        onCloseRef.current();
      })();
      return () => {
        cancelled = true;
      };
    }, [nativeMode]);

    const anchor = position.anchor;
    const anchorKey = anchor ? `${anchor.left},${anchor.top},${anchor.right},${anchor.bottom},${anchor.align ?? ""}` : "";

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

        if (anchor) {
          // Under the anchor, lined up with its start edge (end edge for
          // align="end"); above it when there is no room below.
          const rtl = getComputedStyle(node).direction === "rtl";
          const alignEnd = (anchor.align === "end") !== rtl;
          x = alignEnd ? anchor.right - rect.width : anchor.left;
          y = anchor.bottom + ANCHOR_GAP;
          if (y + rect.height > vh - VIEWPORT_MARGIN && anchor.top - ANCHOR_GAP - rect.height >= VIEWPORT_MARGIN) {
            y = anchor.top - ANCHOR_GAP - rect.height;
          }
        }

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
      // anchorKey stands for anchor, which callers build anew on each render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, mounted, position.x, position.y, anchorKey]);

    const isPositioned = adjustedPosition !== null;

    // Where the focus goes back to: the trigger the opener named, else what
    // had the focus when the menu opened. Read in a layout effect, before
    // the menu takes the focus.
    const returnFocusTo = useRef<HTMLElement | null>(null);
    const trigger = position.trigger;
    useLayoutEffect(() => {
      if (!isOpen) return;
      const active = document.activeElement;
      returnFocusTo.current =
        trigger ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    }, [isOpen, trigger]);

    // Register as the open menu; give the focus back when it closes.
    useEffect(() => {
      if (!isOpen) return;
      const token = {};
      openMenus.push(token);
      syncOpenFlag();
      const menuNode = localRef.current;

      const onKeyDown = (e: KeyboardEvent) => {
        if (openMenus[openMenus.length - 1] !== token) return;
        const root = localRef.current;
        if (!root) return;
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && root.contains(active);
        const current = ((inside ? active.closest('[role="menu"]') : null) as HTMLElement | null) ?? root;
        const consume = (preventDefault = true) => {
          e.stopImmediatePropagation();
          if (preventDefault) e.preventDefault();
        };

        if (e.key === "Escape") {
          consume();
          if (current !== root) closeSubmenuPanel(current);
          else onCloseRef.current();
          return;
        }
        if (e.key === "Tab") {
          consume();
          onCloseRef.current();
          return;
        }
        if (e.isComposing) return;

        if (!inside) {
          // The menu opened without taking the focus (or lost it): the
          // arrows bring it in instead of moving the list behind.
          if (e.key === "ArrowDown" || e.key === "Home") {
            consume();
            focusEl(menuLevelItems(root)[0]);
          } else if (e.key === "ArrowUp" || e.key === "End") {
            consume();
            const items = menuLevelItems(root);
            focusEl(items[items.length - 1]);
          }
          return;
        }

        if (needsKeys(active)) return;
        const text = isSingleLineText(active);
        const rtl = getComputedStyle(root).direction === "rtl";
        const forwardKey = rtl ? "ArrowLeft" : "ArrowRight";
        const backKey = rtl ? "ArrowRight" : "ArrowLeft";
        const submenuTrigger = submenuTriggerOf(active);

        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp": {
            consume();
            const items = menuLevelItems(current);
            if (items.length === 0) return;
            const index = items.indexOf(active);
            const delta = e.key === "ArrowDown" ? 1 : -1;
            const next = index === -1 ? (delta === 1 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
            focusEl(items[next]);
            return;
          }
          case "Home":
          case "End": {
            if (text) return;
            consume();
            const items = menuLevelItems(current);
            focusEl(e.key === "Home" ? items[0] : items[items.length - 1]);
            return;
          }
          case forwardKey:
            if (text) return;
            consume();
            submenuTrigger?.dispatchEvent(new CustomEvent(SUBMENU_OPEN));
            return;
          case backKey:
            if (text) return;
            consume();
            if (current !== root) closeSubmenuPanel(current);
            return;
          case "Enter":
          case " ":
            if (submenuTrigger) {
              consume();
              submenuTrigger.dispatchEvent(new CustomEvent(SUBMENU_OPEN));
              return;
            }
            // The item activates itself (the browser's default action); the
            // app must not also see the key (Enter opens the selected row).
            if (!text) consume(false);
            return;
          default:
            // Letters and the rest: the app's shortcuts are suspended.
            if (!text) consume(false);
        }
      };

      window.addEventListener("keydown", onKeyDown, true);
      return () => {
        window.removeEventListener("keydown", onKeyDown, true);
        const index = openMenus.indexOf(token);
        if (index !== -1) openMenus.splice(index, 1);
        syncOpenFlag();
        requestLevel(null);
        const target = returnFocusTo.current;
        returnFocusTo.current = null;
        const active = document.activeElement;
        const focusLeftWithMenu = !active || active === document.body || (menuNode?.contains(active) ?? false);
        if (target && target.isConnected && focusLeftWithMenu) focusEl(target);
      };
    }, [isOpen, requestLevel]);

    // Once placed (it is invisible, and can't take the focus, before), the
    // first item gets the focus.
    useEffect(() => {
      if (!isOpen || !isPositioned || nativeMode) return;
      const root = localRef.current;
      if (!root || root.contains(document.activeElement)) return;
      return focusFirstItem(root);
    }, [isOpen, isPositioned, nativeMode]);

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

    return createPortal(
      <NativeMenuContext.Provider value={nativeMode}>
      <MenuLevelContext.Provider value={level}>
        <div
          ref={setRefs}
          // w-max: before the first clamp the menu sits where it opened,
          // often near the window's right edge, and would shrink to the room
          // left there. Clamped by that narrower width, it then grows and
          // jumps left (the ⋮ menu slid in).
          className={cn(
            "fixed z-50 w-max min-w-[200px] outline-none",
            CONTEXT_MENU_PANEL_CLASS
          )}
          style={{
            left: renderPosition.x,
            top: renderPosition.y,
            maxWidth: `calc(100vw - ${2 * VIEWPORT_MARGIN}px)`,
            visibility: isPositioned && !nativeMode ? "visible" : "hidden",
          }}
          role="menu"
          aria-label={label}
          aria-orientation="vertical"
          tabIndex={-1}
          onPointerDownCapture={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") lastTouchAt.current = Date.now();
          }}
        >
          {/* Taller than the window: scroll inside the menu. */}
          <div className="py-1 overflow-y-auto" style={{ maxHeight: `calc(100vh - ${2 * VIEWPORT_MARGIN + 2}px)` }}>
            {children}
          </div>
        </div>
      </MenuLevelContext.Provider>
      </NativeMenuContext.Provider>,
      document.body
    );
  }
);

ContextMenu.displayName = "ContextMenu";

// ─── Items ─────────────────────────────────────────────────────

/**
 * The look of a menu row, for a host's own entries inside a ContextMenu
 * (a check or radio item, a plugin's entry). 44px rows on a touch screen
 * (R7); the desktop keeps its density.
 */
export const CONTEXT_MENU_ITEM_CLASS =
  "w-full px-3 py-1.5 text-sm text-start flex items-center gap-2 pointer-coarse:min-h-11 " +
  "transition-colors duration-150 focus:outline-none focus-visible:bg-muted hover:bg-muted cursor-pointer " +
  "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent";

/** The menu's panel look, for a host that draws its own panel (a sheet on the phone). */
export const CONTEXT_MENU_PANEL_CLASS = "bg-background rounded-md shadow-lg border border-border";

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
  const level = useContext(MenuLevelContext);
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      title={title}
      className={cn(
        // 44px rows on a touch screen (R7); the desktop keeps its density.
        "w-full px-3 py-1.5 text-sm text-start flex items-center gap-2 pointer-coarse:min-h-11",
        "transition-colors duration-150",
        "focus:outline-none focus-visible:bg-muted",
        disabled && "opacity-50 cursor-not-allowed",
        !disabled && "hover:bg-muted cursor-pointer",
        destructive && !disabled && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
      )}
      // Hovering another entry closes an open submenu of this level, after
      // a moment, so a diagonal move into the submenu doesn't.
      onMouseEnter={() => {
        // With hover opening off, a submenu stays until a click or a key.
        if (!hoverOpens()) return;
        if (level && level.openId !== null && !level.recentTouch()) level.request(null, HOVER_CLOSE_DELAY);
      }}
      onFocus={() => {
        if (level && level.openId !== null) level.request(null);
      }}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onClick();
      }}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
      {hint ? (
        <span className="flex-1 min-w-0">
          <span className="block" data-menu-label="">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 [overflow-wrap:anywhere]" data-menu-label="">{label}</span>
      )}
      {/* Key hints mean nothing without a keyboard: hidden on touch (R8). */}
      {shortcut && (
        <span className="text-xs text-muted-foreground ms-auto pointer-coarse:hidden">{shortcut}</span>
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

/**
 * An entry with a submenu. It opens on hover (mouse), click or tap, Enter,
 * Space and → (← in RTL), and stays open until another entry of its menu is
 * hovered or chosen, ← or Escape, or the menu closes.
 */
export function ContextMenuSubMenu({
  icon: Icon,
  label,
  children,
  testId,
  disabled = false,
  title,
  hint,
}: ContextMenuSubMenuProps) {
  const parent = useContext(MenuLevelContext);
  const native = useContext(NativeMenuContext);
  const id = useId();
  // Outside a ContextMenu (a host's own panel) it keeps its own state.
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = parent ? parent.openId === id : localOpen;
  const setOpen = useCallback(
    (open: boolean) => {
      if (parent) parent.request(open ? id : null);
      else setLocalOpen(open);
    },
    [parent, id]
  );
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusFirstOnOpen = useRef(false);
  const ownLevel = useMenuLevel(parent?.recentTouch ?? neverTouched);

  // The menu's keyboard handler talks to the entry through DOM events.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const onOpen = () => {
      if (disabled) return;
      setOpen(true);
      if (panelRef.current) focusFirstItem(panelRef.current);
      else focusFirstOnOpen.current = true;
    };
    const onClose = () => {
      setOpen(false);
      focusEl(trigger);
    };
    trigger.addEventListener(SUBMENU_OPEN, onOpen);
    trigger.addEventListener(SUBMENU_CLOSE, onClose);
    return () => {
      trigger.removeEventListener(SUBMENU_OPEN, onOpen);
      trigger.removeEventListener(SUBMENU_CLOSE, onClose);
    };
  }, [disabled, setOpen]);

  const onPanelPlaced = useCallback(() => {
    if (!focusFirstOnOpen.current || !panelRef.current) return;
    focusFirstOnOpen.current = false;
    focusFirstItem(panelRef.current);
  }, []);

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        // Settings > Accessibility can make submenus open on click or
        // Enter only.
        if (!disabled && hoverOpens()) setOpen(true);
      }}
    >
      <div
        ref={triggerRef}
        data-submenu-trigger=""
        className={cn(
          "w-full px-3 py-1.5 text-sm flex items-center gap-2 outline-none pointer-coarse:min-h-11",
          "transition-colors duration-150",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted focus-visible:bg-muted",
          isOpen && !disabled && "bg-muted"
        )}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        title={title}
        onClick={(e) => {
          // A click or tap opens it. It doesn't toggle: the tap that also
          // fired an emulated mouseenter would close it again.
          e.stopPropagation();
          if (!disabled) setOpen(true);
        }}
      >
        {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
        {hint ? (
          <span className="flex-1 min-w-0">
            <span className="block" data-menu-label="">{label}</span>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </span>
        ) : (
          <span className="flex-1" data-menu-label="">{label}</span>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>

      {native && !disabled && (
        <div data-submenu-panel="" role="menu" aria-label={label} hidden={false}>
          {children}
        </div>
      )}
      {!native && isOpen && !disabled && (
        <MenuLevelContext.Provider value={ownLevel}>
          <SubMenuPanel
            ref={panelRef}
            data-submenu-panel=""
            aria-label={label}
            onPlaced={onPanelPlaced}
            className="min-w-[180px] max-w-[min(20rem,calc(100vw-20px))] bg-background rounded-md shadow-lg border border-border"
            role="menu"
          >
            <div className="py-1 max-h-[min(300px,calc(100vh-40px))] overflow-y-auto">
              {children}
            </div>
          </SubMenuPanel>
        </MenuLevelContext.Provider>
      )}
    </div>
  );
}

interface SubMenuPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The side of the entry to open on when it fits; flips with the text direction. */
  side?: "start" | "end";
  /** Called once the panel is placed and visible. */
  onPlaced?: () => void;
  "data-submenu-panel"?: string;
}

/**
 * A submenu's panel, placed beside the entry it is rendered in (its parent
 * element): on `side` when it fits in the window, else on the other side,
 * else clamped inside the window. It is `position: fixed`, so a pane that
 * clips its overflow can't cut it off.
 */
export const SubMenuPanel = forwardRef<HTMLDivElement, SubMenuPanelProps>(function SubMenuPanel(
  { side = "end", onPlaced, className, style, ...rest },
  ref
) {
  const [pos, setPos] = useState<Position | null>(null);
  const subMenuRef = useRef<HTMLDivElement | null>(null);

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

  const placed = pos !== null;
  const onPlacedRef = useRef(onPlaced);
  useEffect(() => {
    onPlacedRef.current = onPlaced;
  });
  useEffect(() => {
    if (placed) onPlacedRef.current?.();
  }, [placed]);

  const setRefs = (node: HTMLDivElement | null) => {
    subMenuRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <div
      {...rest}
      ref={setRefs}
      className={cn("fixed z-50", className)}
      style={{
        ...style,
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    />
  );
});

interface ContextMenuHeaderProps {
  children: React.ReactNode;
}

export function ContextMenuHeader({ children }: ContextMenuHeaderProps) {
  return (
    <div data-context-menu-header="" className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
      {children}
    </div>
  );
}
