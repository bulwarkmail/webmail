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
import { Check, ChevronRight } from "@/components/icons";
import { placeMenu, placeSubmenu, windowTopEdge } from "@/lib/menu-placement";
import { formatShortcutCombo } from "@/lib/shortcut-keys";
import { useDialogSurfaceContext } from "@/components/ui/dialog-surface";

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
  /** What it's for: marked `data-menu-opener` while it's open, so a list row shows it. */
  opener?: HTMLElement | null;
  /** Opened by a right-click: the pointer sits on it, and only counts once it moves. */
  fromPointer?: boolean;
}

/** How far the pointer moves before a menu opened under it answers it. */
const POINTER_SLOP = 3;

interface ContextMenuProps {
  isOpen: boolean;
  position: ContextMenuPosition;
  onClose: () => void;
  children: React.ReactNode;
  /** The menu's accessible name, e.g. the label of the ⋮ button that opens it. */
  label?: string;
  /** Opened from inside a dialog: drawn above it (dialogs are at z-[60]). */
  overDialog?: boolean;
}

const VIEWPORT_MARGIN = 10;
const ANCHOR_GAP = 4;
const HOVER_CLOSE_DELAY = 150;
/** Letters typed within this many ms make one type-ahead word. */
const TYPE_AHEAD_MS = 700;
/** Every menu and submenu is at most this wide; longer labels wrap. */
const MENU_MAX_WIDTH = `min(22rem, calc(100vw - ${2 * 10}px))`;

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

const subscribeNothing = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

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

/** A row's words for type-ahead: its label, else its text. */
function itemText(el: HTMLElement): string {
  return (el.querySelector<HTMLElement>("[data-menu-label]")?.textContent ?? el.textContent ?? "").trim().toLowerCase();
}

/**
 * Type-ahead: the next row after `from` whose words start with `typed`, going round.
 * A repeated single letter steps through the rows that start with it.
 */
export function typeAheadTarget(items: HTMLElement[], from: HTMLElement | null, typed: string): HTMLElement | undefined {
  if (!typed || items.length === 0) return undefined;
  const start = from ? items.indexOf(from) : -1;
  const repeated = typed.length > 1 && [...typed].every((c) => c === typed[0]);
  const prefix = repeated ? typed[0] : typed;
  // Typing on (more letters): the current row may still match; one letter moves on.
  const offset = typed.length > 1 && !repeated ? 0 : 1;
  for (let i = 0; i < items.length; i++) {
    const item = items[(start + offset + i + items.length) % items.length];
    if (itemText(item).startsWith(prefix)) return item;
  }
  return undefined;
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

/** Marks the part of a menu or submenu that scrolls when it is taller than the window. */
const SCROLL_ATTRIBUTE = "data-menu-scroll";

function focusEl(el: HTMLElement | undefined | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  revealInMenu(el);
}

/**
 * A menu that scrolls brings the row the keys moved to into view. Only its own
 * list scrolls: the page behind and the parent menu stay where they are.
 */
function revealInMenu(el: HTMLElement) {
  const list = el.closest<HTMLElement>(`[${SCROLL_ATTRIBUTE}]`);
  if (!list || list.scrollHeight <= list.clientHeight) return;
  // The first and last rows bring the list's padding along.
  const level = el.closest<HTMLElement>('[role="menu"]');
  const rows = level ? menuLevelItems(level) : [];
  if (rows[0] === el) {
    list.scrollTop = 0;
    return;
  }
  if (rows[rows.length - 1] === el) {
    list.scrollTop = list.scrollHeight - list.clientHeight;
    return;
  }
  const row = el.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (row.top < box.top) list.scrollTop -= box.top - row.top;
  else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom;
}

/** The height a menu panel would have uncapped: a cap set last time mustn't decide the next. */
function uncappedHeight(panel: HTMLElement, rect: DOMRect): number {
  const list = panel.firstElementChild as HTMLElement | null;
  return list && list.scrollHeight > list.clientHeight ? rect.height + list.scrollHeight - list.clientHeight : rect.height;
}

/** The scrolling list's cap for a panel capped at `maxHeight` (its border is 1px each side). */
function listMaxHeight(maxHeight: number | undefined): string {
  return maxHeight !== undefined
    ? `${Math.max(0, maxHeight - 2)}px`
    : `calc(100vh - ${2 * VIEWPORT_MARGIN + 2}px)`;
}

/**
 * Focus the first item of a menu level once it can take the focus: entries
 * can render a moment after the menu (the mail menu waits for its data), and
 * a panel that just turned visible can count as hidden for a frame. Gives
 * up when the focus goes somewhere else meanwhile. Returns a cancel.
 */
function focusFirstItem(level: HTMLElement): () => void {
  const doc = level.ownerDocument;
  const win = doc.defaultView ?? window;
  const from = doc.activeElement;
  let frame = 0;
  let tries = 0;
  let done = false;
  const attempt = () => {
    if (done) return;
    const active = doc.activeElement;
    if ((active && level.contains(active)) || active !== from) {
      done = true;
      return;
    }
    const first = menuLevelItems(level)[0];
    focusEl(first);
    if (first && doc.activeElement === first) {
      done = true;
      return;
    }
    if (++tries < 30) frame = win.requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    done = true;
    win.cancelAnimationFrame(frame);
  };
}

// Events the menu sends to a submenu's entry.
const SUBMENU_OPEN = "contextmenu:submenu-open";
const SUBMENU_CLOSE = "contextmenu:submenu-close";

/** An element, from this window or a dialog window (whose elements aren't this window's HTMLElement). */
function isElement(node: unknown): node is HTMLElement {
  return !!node && typeof (node as HTMLElement).nodeType === "number" && (node as HTMLElement).nodeType === 1 && "dataset" in (node as HTMLElement);
}

function submenuTriggerOf(el: Element | null): HTMLElement | null {
  return isElement(el) && el.dataset.submenuTrigger !== undefined ? el : null;
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
      if (active?.tagName === "INPUT" && active.closest("[data-submenu-panel]")) return;
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
  ({ isOpen, position, onClose, children, label, overDialog = false }, ref) => {
    // In the browser after hydration: a portal needs document.body. True from
    // the first render for a menu mounted later, so a closed menu that comes
    // with a row or a toolbar costs no second render pass.
    const mounted = useSyncExternalStore(subscribeNothing, clientSnapshot, serverSnapshot);
    // Drawn in the window it was opened in: a dialog window has its own (dialog-surface.tsx).
    const surface = useDialogSurfaceContext();
    const ownerWin: Window = surface?.win ?? (typeof window === "undefined" ? (undefined as unknown as Window) : window);
    const ownerDoc: Document = surface?.doc ?? (typeof document === "undefined" ? (undefined as unknown as Document) : document);
    const [adjustedPosition, setAdjustedPosition] = useState<(Position & { maxHeight?: number }) | null>(null);
    const localRef = useRef<HTMLDivElement | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
      onCloseRef.current = onClose;
    });
    const lastTouchAt = useRef(0);
    const recentTouch = useCallback(() => Date.now() - lastTouchAt.current < 800, []);
    const level = useMenuLevel(recentTouch);
    const { request: requestLevel } = level;
    // Type-ahead: what was typed, and when.
    const typed = useRef("");
    const typedAt = useRef(0);

    // The desktop app shows this same menu, not a native copy: a native menu
    // has no icons, and writes keys with Chromium's names rather than Windows'.

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
        // Next to the button it opened from, or at the pointer (lib/menu-placement.ts).
        const { x, y, maxHeight } = placeMenu({
          point: { x: position.x, y: position.y },
          anchor,
          size: { width: rect.width, height: uncappedHeight(node, rect) },
          viewport: { width: ownerWin.innerWidth, height: ownerWin.innerHeight },
          rtl: getComputedStyle(node).direction === "rtl",
          margin: VIEWPORT_MARGIN,
          gap: ANCHOR_GAP,
          topEdge: windowTopEdge(ownerDoc),
        });

        setAdjustedPosition((prev) =>
          prev && prev.x === x && prev.y === y && prev.maxHeight === maxHeight ? prev : { x, y, maxHeight }
        );
      };
      clamp();
      // A window made smaller (or zoomed) while the menu is open.
      ownerWin.addEventListener("resize", clamp);
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(clamp);
      observer?.observe(node);
      return () => {
        ownerWin.removeEventListener("resize", clamp);
        observer?.disconnect();
      };
      // anchorKey stands for anchor, which callers build anew on each render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, mounted, position.x, position.y, anchorKey]);

    const isPositioned = adjustedPosition !== null;

    // Opened by a right-click, the menu comes up under the pointer: the item
    // there isn't hovered, and its submenu doesn't open, until the pointer
    // moves. A tap or a key counts at once.
    const [pointerArmed, setPointerArmed] = useState(true);
    const fromPointer = isOpen && position.fromPointer === true;
    useLayoutEffect(() => {
      if (!fromPointer) {
        setPointerArmed(true);
        return;
      }
      setPointerArmed(false);
      const start = { x: position.x, y: position.y };
      const arm = () => setPointerArmed(true);
      const onMove = (e: PointerEvent) => {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > POINTER_SLOP) arm();
      };
      ownerDoc.addEventListener("pointermove", onMove, true);
      ownerDoc.addEventListener("pointerdown", arm, true);
      ownerDoc.addEventListener("keydown", arm, true);
      return () => {
        ownerDoc.removeEventListener("pointermove", onMove, true);
        ownerDoc.removeEventListener("pointerdown", arm, true);
        ownerDoc.removeEventListener("keydown", arm, true);
      };
    }, [fromPointer, position.x, position.y, ownerDoc]);

    // The row the menu is for stays marked while it's open (app/globals.css).
    const opener = isOpen ? position.opener ?? null : null;
    useEffect(() => {
      if (!opener) return;
      opener.setAttribute("data-menu-opener", "");
      return () => opener.removeAttribute("data-menu-opener");
    }, [opener]);

    // Where the focus goes back to: the trigger the opener named, else what
    // had the focus when the menu opened. Read in a layout effect, before
    // the menu takes the focus.
    const returnFocusTo = useRef<HTMLElement | null>(null);
    const trigger = position.trigger;
    useLayoutEffect(() => {
      if (!isOpen) return;
      const active = ownerDoc.activeElement;
      returnFocusTo.current =
        trigger ?? (isElement(active) && active !== ownerDoc.body ? active : null);
    }, [isOpen, trigger, ownerDoc]);

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
        const active = ownerDoc.activeElement;
        const inside = isElement(active) && root.contains(active);
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
            // Letters and the rest: the app's shortcuts are suspended. A letter
            // goes to the next row that starts with it (type-ahead).
            if (text) return;
            consume(false);
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.trim()) {
              const now = Date.now();
              typed.current = now - typedAt.current < TYPE_AHEAD_MS ? typed.current + e.key.toLowerCase() : e.key.toLowerCase();
              typedAt.current = now;
              const target = typeAheadTarget(menuLevelItems(current), active, typed.current);
              if (target) {
                e.preventDefault();
                focusEl(target);
              }
            }
        }
      };

      ownerWin.addEventListener("keydown", onKeyDown, true);
      return () => {
        ownerWin.removeEventListener("keydown", onKeyDown, true);
        const index = openMenus.indexOf(token);
        if (index !== -1) openMenus.splice(index, 1);
        syncOpenFlag();
        requestLevel(null);
        const target = returnFocusTo.current;
        returnFocusTo.current = null;
        const active = ownerDoc.activeElement;
        const focusLeftWithMenu = !active || active === ownerDoc.body || (menuNode?.contains(active) ?? false);
        if (target && target.isConnected && focusLeftWithMenu) focusEl(target);
      };
    }, [isOpen, requestLevel, ownerDoc, ownerWin]);

    // Once placed (it is invisible, and can't take the focus, before), the
    // first item gets the focus.
    useEffect(() => {
      if (!isOpen || !isPositioned) return;
      const root = localRef.current;
      if (!root || root.contains(ownerDoc.activeElement)) return;
      return focusFirstItem(root);
    }, [isOpen, isPositioned, ownerDoc]);

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
      <MenuLevelContext.Provider value={level}>
        <div
          ref={setRefs}
          // w-max: before the first clamp the menu sits where it opened,
          // often near the window's right edge, and would shrink to the room
          // left there. Clamped by that narrower width, it then grows and
          // jumps left (the ⋮ menu slid in).
          className={cn(
            "fixed w-max min-w-[200px] outline-none",
            overDialog ? "z-[70]" : "z-50",
            CONTEXT_MENU_PANEL_CLASS
          )}
          style={{
            left: renderPosition.x,
            top: renderPosition.y,
            maxWidth: MENU_MAX_WIDTH,
            visibility: isPositioned ? "visible" : "hidden",
          }}
          role="menu"
          aria-label={label}
          aria-orientation="vertical"
          tabIndex={-1}
          data-pointer-unarmed={pointerArmed ? undefined : ""}
          onPointerDownCapture={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen") lastTouchAt.current = Date.now();
          }}
        >
          {/* Taller than the window: scroll inside the menu. */}
          <div
            className="py-1 overflow-y-auto"
            data-menu-scroll=""
            style={{ maxHeight: listMaxHeight(adjustedPosition?.maxHeight) }}
          >
            {children}
          </div>
        </div>
      </MenuLevelContext.Provider>,
      ownerDoc.body
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
  /** The key that does the same, shown apart from the label. */
  shortcut?: string;
  /** A count at the end of the row, e.g. unread notifications. Not a key. */
  badge?: string;
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
  badge,
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
        destructive && !disabled && "hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
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
      {Icon && <Icon className={cn("w-4 h-4 flex-shrink-0", destructive && !disabled && "text-destructive")} />}
      {hint ? (
        <span className="flex-1 min-w-0">
          <span className="block" data-menu-label="">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 [overflow-wrap:anywhere]" data-menu-label="">{label}</span>
      )}
      {shortcut && <MenuShortcut keys={shortcut} />}
      {badge && <MenuBadge text={badge} />}
    </button>
  );
}

interface ContextMenuCheckItemProps {
  /** With an icon, it takes the icon column and the tick goes to the row's end. */
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  checked: boolean;
  onClick: () => void;
  /** "radio": one of a group (a sort order, a view); "checkbox": on or off. */
  kind?: "checkbox" | "radio";
  disabled?: boolean;
  shortcut?: string;
  testId?: string;
  title?: string;
  hint?: string;
}

/**
 * A row that is on or off, or one of a group: the tick sits in the icon column, so its
 * label lines up with the rows that have icons.
 */
export function ContextMenuCheckItem({ icon: Icon, label, checked, onClick, kind = "checkbox", disabled = false, shortcut, testId, title, hint }: ContextMenuCheckItemProps) {
  const level = useContext(MenuLevelContext);
  return (
    <button
      type="button"
      role={kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={checked}
      data-testid={testId}
      disabled={disabled}
      title={title}
      className={cn(CONTEXT_MENU_ITEM_CLASS, !disabled && "hover:bg-muted")}
      onMouseEnter={() => {
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
      {Icon ? (
        <Icon className="w-4 h-4 flex-shrink-0" />
      ) : (
        <span className="w-4 h-4 shrink-0 flex items-center justify-center" aria-hidden="true">
          {checked && <Check className="w-4 h-4" />}
        </span>
      )}
      {hint ? (
        <span className="flex-1 min-w-0">
          <span className="block" data-menu-label="">{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      ) : (
        <span className="flex-1 min-w-0 [overflow-wrap:anywhere]" data-menu-label="">{label}</span>
      )}
      {shortcut && <MenuShortcut keys={shortcut} />}
      {Icon && <Check className={cn("w-4 h-4 shrink-0", !checked && "invisible")} aria-hidden="true" />}
    </button>
  );
}

/**
 * The key that does what a menu row does, at the row's end, muted, as a keycap, in the
 * app's language as Windows writes it ("Umschalt + R", "Entf" in German). Key hints mean
 * nothing without a keyboard: hidden on touch (R8).
 */
export function MenuShortcut({ keys, className, ...rest }: { keys: string; className?: string } & Omit<React.HTMLAttributes<HTMLElement>, "children">) {
  return (
    <kbd
      {...rest}
      data-menu-shortcut=""
      className={cn(
        "ms-auto shrink-0 rounded border border-border px-1.5 font-sans text-[0.6875rem] leading-4 text-muted-foreground pointer-coarse:hidden",
        className
      )}
    >
      {formatShortcutCombo(keys)}
    </kbd>
  );
}

/** A count at a row's end ("3" unread). Not a key: a native menu puts it after the label. */
export function MenuBadge({ text }: { text: string }) {
  return (
    <span data-menu-badge="" className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
      {text}
    </span>
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
      onMouseEnter={(e) => {
        // Settings > Accessibility can make submenus open on click or
        // Enter only. Not under the pointer that just opened the menu.
        if (e.currentTarget.closest("[data-pointer-unarmed]")) return;
        if (!disabled && hoverOpens()) setOpen(true);
      }}
      onMouseMove={(e) => {
        // The browser sends mouseenter before the pointermove that arms the
        // menu: a pointer that jumped onto the entry opens it once it moves.
        if (isOpen || disabled || !triggerRef.current?.contains(e.target as Node)) return;
        if (e.currentTarget.closest("[data-pointer-unarmed]")) return;
        if (hoverOpens()) setOpen(true);
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

      {isOpen && !disabled && (
        <MenuLevelContext.Provider value={ownLevel}>
          <SubMenuPanel
            ref={panelRef}
            data-submenu-panel=""
            aria-label={label}
            onPlaced={onPanelPlaced}
            className={cn("min-w-[180px]", CONTEXT_MENU_PANEL_CLASS)}
            style={{ maxWidth: MENU_MAX_WIDTH }}
            role="menu"
          >
            {children}
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
 * element) by placeSubmenu (lib/menu-placement.ts): on `side` when it fits in
 * the window, else on the other side; moved up so it ends inside the window;
 * capped and scrolling when it's taller than the window. It is `position:
 * fixed`, so a pane that clips its overflow can't cut it off.
 *
 * Placed again when it changes size (a rules list that loads after it opened),
 * when the window does, and when its entry moves (the menu it's in scrolls).
 */
export const SubMenuPanel = forwardRef<HTMLDivElement, SubMenuPanelProps>(function SubMenuPanel(
  { side = "end", onPlaced, className, style, children, ...rest },
  ref
) {
  const [pos, setPos] = useState<(Position & { maxHeight?: number }) | null>(null);
  const surface = useDialogSurfaceContext();
  const ownerWin: Window = surface?.win ?? (typeof window === "undefined" ? (undefined as unknown as Window) : window);
  const ownerDoc: Document = surface?.doc ?? (typeof document === "undefined" ? (undefined as unknown as Document) : document);
  const subMenuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const subEl = subMenuRef.current;
    const itemEl = subEl?.parentElement;
    if (!subEl || !itemEl) return;

    const place = () => {
      const itemRect = itemEl.getBoundingClientRect();
      const subRect = subEl.getBoundingClientRect();
      const placed = placeSubmenu({
        item: itemRect,
        size: { width: subRect.width, height: uncappedHeight(subEl, subRect) },
        viewport: { width: ownerWin.innerWidth, height: ownerWin.innerHeight },
        rtl: getComputedStyle(itemEl).direction === "rtl",
        side,
        margin: VIEWPORT_MARGIN,
        gap: ANCHOR_GAP,
        topEdge: windowTopEdge(ownerDoc),
      });
      // Where left/top 0 would put the panel: the origin `position: fixed`
      // resolves against. That is the viewport, unless a theme gives the
      // parent menu a backdrop-filter, filter or transform: then the parent is
      // the containing block and viewport coordinates land offset by the
      // parent's own position, far from the entry (#1149).
      const originX = subRect.left - (parseFloat(subEl.style.left) || 0);
      const originY = subRect.top - (parseFloat(subEl.style.top) || 0);
      const next = { x: placed.x - originX, y: placed.y - originY, maxHeight: placed.maxHeight };
      setPos((prev) =>
        prev && prev.x === next.x && prev.y === next.y && prev.maxHeight === next.maxHeight ? prev : next
      );
    };
    place();

    ownerWin.addEventListener("resize", place);
    // The menu the entry is in scrolls: the entry moves, and the panel with it.
    const parentList = itemEl.closest<HTMLElement>(`[${SCROLL_ATTRIBUTE}]`);
    parentList?.addEventListener("scroll", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(subEl);
    // The parent menu moves when it changes size (it's placed again).
    const parentMenu = itemEl.closest<HTMLElement>('[role="menu"]');
    if (parentMenu) observer?.observe(parentMenu);
    return () => {
      ownerWin.removeEventListener("resize", place);
      parentList?.removeEventListener("scroll", place);
      observer?.disconnect();
    };
  }, [side, ownerDoc, ownerWin]);

  // Placed anew (its rows loaded, the window changed): the row that has the
  // focus stays in view.
  useLayoutEffect(() => {
    const active = ownerDoc.activeElement;
    if (pos && isElement(active) && subMenuRef.current?.contains(active)) revealInMenu(active);
  }, [pos, ownerDoc]);

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

  // w-max: as wide as its labels (up to its max width) wherever it sits, so
  // moving it to the window's edge doesn't wrap them onto more lines and make
  // it taller than it was measured.
  return (
    <div
      {...rest}
      ref={setRefs}
      className={cn("fixed z-50 w-max", className)}
      style={{
        ...style,
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {/* Taller than the window: it scrolls inside, as a long menu does. */}
      <div className="py-1 overflow-y-auto" data-menu-scroll="" style={{ maxHeight: listMaxHeight(pos?.maxHeight) }}>
        {children}
      </div>
    </div>
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
