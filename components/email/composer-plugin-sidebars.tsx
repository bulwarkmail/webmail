"use client";

// The composer-sidebar and composer-sidebar-right plugin panels. Each has a
// width the user can drag (kept across composers) and a button in the
// composer's header that shows and hides it (the left panel's at the start,
// the right one's at the end, like the reader's). Folded, a panel takes no
// room at all. When the composer is too narrow for an open panel next to
// it, the panel folds by itself (right first); opening it anyway lays it
// over the composer instead of squeezing the message into a column nobody
// can write in. Laid over, it stays between the composer's header and its
// bottom bar: the panel's own button, Close and Send stay in reach.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "@/components/icons";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { onPanelRequest, type PanelRequest } from "@/lib/plugin-sandbox/panel-requests";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { cn } from "@/lib/utils";

/** Width of an open panel until the user drags it. */
export const COMPOSER_SIDEBAR_WIDTH = 260;
export const MIN_COMPOSER_SIDEBAR_WIDTH = 220;
export const MAX_COMPOSER_SIDEBAR_WIDTH = 480;
/** Below this window width the panels are not shown at all (the `md` breakpoint). */
export const COMPOSER_SIDEBAR_MIN_WINDOW = 768;
/**
 * Narrowest the composer itself may get next to open panels: below this its
 * bottom bar (Attach, Templates, Options, Discard, Send) runs into itself.
 */
export const MIN_COMPOSER_WIDTH = 560;

export type ComposerSidebarSide = "left" | "right";
/** docked: open beside the composer; folded: hidden; overlay: open over the composer. */
export type ComposerSidebarMode = "docked" | "folded" | "overlay";

interface SideState {
  present: boolean;
  /** Folded by the user. */
  collapsed: boolean;
  /** Opened by the user while there was no room for it. */
  overlayOpen?: boolean;
  /** The user's width for it; the default when not dragged yet. */
  width?: number;
}

/**
 * How each panel is shown in a composer `width` px wide (0 = not measured
 * yet: everything the user left open is shown open). The left panel gets
 * room first, since the right one is folded first.
 */
export function composerSidebarModes(
  width: number,
  left: SideState,
  right: SideState,
): Record<ComposerSidebarSide, ComposerSidebarMode | null> {
  let room = width > 0 ? width - MIN_COMPOSER_WIDTH : Infinity;
  const place = (side: SideState): ComposerSidebarMode | null => {
    if (!side.present) return null;
    if (side.collapsed) return "folded";
    const extra = side.width ?? COMPOSER_SIDEBAR_WIDTH;
    if (extra <= room) {
      room -= extra;
      return "docked";
    }
    return side.overlayOpen ? "overlay" : "folded";
  };
  const l = place(left);
  return { left: l, right: place(right) };
}

const storageKey = (side: ComposerSidebarSide) => `composerPluginSidebarCollapsed:${side}`;
const widthKey = (side: ComposerSidebarSide) => `composerPluginSidebarWidth:${side}`;

/** The user's choice for a side; null until they fold or open it once. */
function readCollapsed(side: ComposerSidebarSide): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey(side));
    return stored === "1" ? true : stored === "0" ? false : null;
  } catch { return null; }
}

export function clampSidebarWidth(width: number): number {
  return Math.max(MIN_COMPOSER_SIDEBAR_WIDTH, Math.min(MAX_COMPOSER_SIDEBAR_WIDTH, Math.round(width)));
}

function readWidth(side: ComposerSidebarSide): number {
  if (typeof window === "undefined") return COMPOSER_SIDEBAR_WIDTH;
  try {
    const n = parseInt(localStorage.getItem(widthKey(side)) ?? "", 10);
    return Number.isFinite(n) ? clampSidebarWidth(n) : COMPOSER_SIDEBAR_WIDTH;
  } catch { return COMPOSER_SIDEBAR_WIDTH; }
}

/**
 * Layout state of both panels for a composer whose root element is `root`.
 * `composerId` is the id plugins know this composer by; their
 * api.ui.openPanel requests for it are answered here.
 */
export function useComposerSidebars(root: HTMLElement | null, composerId: string | null = null) {
  const leftOffers = usePluginSlotOffers("composer-sidebar");
  const rightOffers = usePluginSlotOffers("composer-sidebar-right");
  const hasLeft = leftOffers.length > 0;
  const hasRight = rightOffers.length > 0;
  const [width, setWidth] = useState(0);
  // The user's choice per side; until they make one, a panel whose plugin
  // asked to start folded (a chat opened on demand) is folded, the rest open.
  const [chosen, setChosen] = useState<Record<ComposerSidebarSide, boolean | null>>(() => ({
    left: readCollapsed("left"),
    right: readCollapsed("right"),
  }));
  const collapsed: Record<ComposerSidebarSide, boolean> = {
    left: chosen.left ?? leftOffers.some((o) => o.startFolded),
    right: chosen.right ?? rightOffers.some((o) => o.startFolded),
  };
  const [overlayOpen, setOverlayOpen] = useState<Record<ComposerSidebarSide, boolean>>({ left: false, right: false });
  const [widths, setWidths] = useState<Record<ComposerSidebarSide, number>>(() => ({ left: readWidth("left"), right: readWidth("right") }));

  useEffect(() => {
    if (!root || (!hasLeft && !hasRight) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.round(entries[0]?.contentRect.width ?? root.getBoundingClientRect().width));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [root, hasLeft, hasRight]);

  const modes = composerSidebarModes(
    width,
    { present: hasLeft, collapsed: collapsed.left, overlayOpen: overlayOpen.left, width: widths.left },
    { present: hasRight, collapsed: collapsed.right, overlayOpen: overlayOpen.right, width: widths.right },
  );

  /** The user dragged a panel's edge. */
  const setSideWidth = (side: ComposerSidebarSide, value: number) => {
    const next = clampSidebarWidth(value);
    setWidths((prev) => (prev[side] === next ? prev : { ...prev, [side]: next }));
    try { localStorage.setItem(widthKey(side), String(next)); } catch { /* storage blocked */ }
  };

  const setSideCollapsed = (side: ComposerSidebarSide, value: boolean) => {
    setChosen((prev) => ({ ...prev, [side]: value }));
    try { localStorage.setItem(storageKey(side), value ? "1" : "0"); } catch { /* storage blocked */ }
  };

  /** Open a folded panel: beside the composer when it fits, over it otherwise. */
  const open = (side: ComposerSidebarSide) => {
    const next = { ...collapsed, [side]: false };
    const fits = composerSidebarModes(
      width,
      { present: hasLeft, collapsed: next.left, width: widths.left },
      { present: hasRight, collapsed: next.right, width: widths.right },
    )[side] === "docked";
    setSideCollapsed(side, false);
    setOverlayOpen((prev) => ({ ...prev, [side]: !fits }));
  };
  const close = (side: ComposerSidebarSide) => {
    setSideCollapsed(side, true);
    setOverlayOpen((prev) => ({ ...prev, [side]: false }));
  };

  // Plugins opening their panel (api.ui.openPanel): counts up per side when
  // it opens, and reaches the slot as `focusRequest`.
  const [focusRequests, setFocusRequests] = useState<Record<ComposerSidebarSide, number>>({ left: 0, right: 0 });
  const latest = useRef({ modes, open, close, composerId, hasLeft, hasRight });
  latest.current = { modes, open, close, composerId, hasLeft, hasRight };
  useEffect(() => onPanelRequest((request: PanelRequest) => {
    const side: ComposerSidebarSide | null = request.slot === "composer-sidebar" ? "left" : request.slot === "composer-sidebar-right" ? "right" : null;
    if (!side) return null;
    const state = latest.current;
    if (request.composerId && request.composerId !== state.composerId) return null;
    if (!(side === "left" ? state.hasLeft : state.hasRight)) return null;
    // On a phone the panels are not on screen (hidden below md): the plugin
    // then falls back to a dialog.
    if (typeof window !== "undefined" && window.innerWidth < COMPOSER_SIDEBAR_MIN_WINDOW) return null;
    const isOpen = state.modes[side] === "docked" || state.modes[side] === "overlay";
    const wantOpen = request.mode === "open" ? true : request.mode === "close" ? false : !isOpen;
    if (wantOpen) {
      if (!isOpen) state.open(side);
      setFocusRequests((prev) => ({ ...prev, [side]: prev[side] + 1 }));
    } else if (isOpen) {
      state.close(side);
    }
    return wantOpen;
  }), []);

  /** The header button: open (and focus the panel, as a plugin's request does) or close. */
  const toggle = (side: ComposerSidebarSide) => {
    if (modes[side] === "docked" || modes[side] === "overlay") {
      close(side);
    } else if (modes[side]) {
      open(side);
      setFocusRequests((prev) => ({ ...prev, [side]: prev[side] + 1 }));
    }
  };

  return { modes, open, close, toggle, focusRequests, widths, setSideWidth };
}

/** The button in the composer's header that shows and hides one panel (none on phones). */
export function ComposerPanelToggle({
  side,
  mode,
  onToggle,
  className,
}: {
  side: ComposerSidebarSide;
  mode: ComposerSidebarMode | null;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations("email_viewer");
  if (!mode) return null;
  const isOpen = mode !== "folded";
  const Icon = side === "left" ? (isOpen ? PanelLeftClose : PanelLeftOpen) : (isOpen ? PanelRightClose : PanelRightOpen);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn("hidden md:grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", className)}
      title={t(isOpen ? "plugin_panel_hide" : "plugin_panel_show")}
      aria-label={t(isOpen ? "plugin_panel_hide" : "plugin_panel_show")}
      aria-pressed={isOpen}
      data-composer-panel-toggle={side}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

const COMPOSER_HEADER = "[data-composer-header], [data-mv-compose-titlebar], [data-mv-compose-inline-bar]";
const COMPOSER_FOOTER = "[data-composer-footer]";

/** How far a panel laid over the composer keeps off its top and bottom, to leave the header and the bottom bar free. */
function useOverlayInsets(active: boolean, panelRef: RefObject<HTMLElement | null>): { top: number; bottom: number } {
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });
  useLayoutEffect(() => {
    const root = panelRef.current?.parentElement;
    if (!active || !root) return;
    const header = root.querySelector(COMPOSER_HEADER);
    const footer = root.querySelector(COMPOSER_FOOTER);
    const measure = () => {
      const box = root.getBoundingClientRect();
      const top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom - box.top)) : 0;
      const bottom = footer ? Math.max(0, Math.round(box.bottom - footer.getBoundingClientRect().top)) : 0;
      setInsets((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of [root, header, footer]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [active, panelRef]);
  return insets;
}

/** One plugin panel of the composer, in the mode useComposerSidebars picked. */
export function ComposerPluginSidebar({
  side,
  mode,
  extraProps,
  width = COMPOSER_SIDEBAR_WIDTH,
  onWidthChange,
}: {
  side: ComposerSidebarSide;
  mode: ComposerSidebarMode | null;
  /** What the panel's plugins get: the composer id, the draft and the selection (see the slot catalogue). */
  extraProps?: Record<string, unknown>;
  width?: number;
  /** The user drags the panel's edge; without it the panel has no handle. */
  onWidthChange?: (width: number) => void;
}) {
  const dragStart = useRef(width);
  const panelRef = useRef<HTMLDivElement>(null);
  const insets = useOverlayInsets(mode === "overlay", panelRef);
  if (!mode) return null;
  const border = side === "left" ? "border-e" : "border-s";

  // Folded: nothing on screen (the header button brings it back).
  if (mode === "folded") {
    return <div hidden data-composer-sidebar={side} data-composer-sidebar-mode="folded" />;
  }

  // Docked beside the composer: a handle on the panel's inner edge. Dragging
  // towards the composer widens the panel (the delta flips for the right one).
  const handle = mode === "docked" && onWidthChange ? (
    <ResizeHandle
      testId={`composer-sidebar-resize-${side}`}
      pane="sidePanel"
      value={width}
      min={MIN_COMPOSER_SIDEBAR_WIDTH}
      max={MAX_COMPOSER_SIDEBAR_WIDTH}
      className="hidden md:block"
      onResizeStart={() => { dragStart.current = width; }}
      onResize={(delta) => onWidthChange(dragStart.current + (side === "left" ? delta : -delta))}
      onResizeEnd={() => { dragStart.current = width; }}
      onDoubleClick={() => onWidthChange(COMPOSER_SIDEBAR_WIDTH)}
    />
  ) : null;
  return (
    <>
    {side === "right" && handle}
    <div
      ref={panelRef}
      className={cn(
        "hidden md:flex flex-col shrink-0 border-border bg-background overflow-hidden",
        border,
        mode === "overlay" ? cn("absolute z-30 shadow-xl", side === "left" ? "start-0" : "end-0") : "h-full",
      )}
      style={mode === "overlay" ? { width, top: insets.top, bottom: insets.bottom } : { width }}
      data-composer-sidebar={side}
      data-composer-sidebar-mode={mode}
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {side === "left"
          ? <PluginSlot name="composer-sidebar" className="flex flex-col" extraProps={extraProps} />
          : <PluginSlot name="composer-sidebar-right" className="flex flex-col" extraProps={extraProps} />}
      </div>
    </div>
    {side === "left" && handle}
    </>
  );
}
