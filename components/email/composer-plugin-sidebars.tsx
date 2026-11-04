"use client";

// The composer-sidebar and composer-sidebar-right plugin panels. Each has a
// width the user can drag (kept across composers). The composer's header
// runs across the whole composer, panels included, so its window buttons
// (Full screen, Pop out, Close) stay at the far end of it, as Outlook and
// Gmail have them. The part of that row above an open panel is the
// panel's head: it holds "Hide <panel>", at the panel's inner edge. A
// folded panel takes no room at all, and a "Show <panel>" button in the
// header brings it back (the left panel's at the start, the right one's
// before the window buttons). An open panel takes its width from the
// composer, down to its narrowest, as long as the composer keeps
// MIN_COMPOSER_WIDTH. When even that doesn't fit, the panel folds by itself
// (right first); opening it anyway puts it beside the composer, over the
// message list, and only where there is no room there either over the
// message's text, below To, Cc and Subject: never over the composer's own
// fields (compose-p3-4). Hide, Close and Send stay in reach.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "@/components/icons";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { get as getActivePlugin } from "@/lib/plugin-sandbox/registry";
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
  return composerSidebarLayout(width, left, right).modes;
}

/**
 * composerSidebarModes, with the width each open panel gets: the user's,
 * or what the composer can spare beside its MIN_COMPOSER_WIDTH, down to
 * MIN_COMPOSER_SIDEBAR_WIDTH. Only below that does a panel fold.
 */
export function composerSidebarLayout(
  width: number,
  left: SideState,
  right: SideState,
): { modes: Record<ComposerSidebarSide, ComposerSidebarMode | null>; widths: Record<ComposerSidebarSide, number> } {
  let room = width > 0 ? width - MIN_COMPOSER_WIDTH : Infinity;
  const widths: Record<ComposerSidebarSide, number> = {
    left: left.width ?? COMPOSER_SIDEBAR_WIDTH,
    right: right.width ?? COMPOSER_SIDEBAR_WIDTH,
  };
  const place = (key: ComposerSidebarSide, side: SideState): ComposerSidebarMode | null => {
    if (!side.present) return null;
    if (side.collapsed) return "folded";
    const wanted = widths[key];
    const given = Math.min(wanted, room);
    if (given >= Math.min(wanted, MIN_COMPOSER_SIDEBAR_WIDTH)) {
      room -= given;
      widths[key] = given;
      return "docked";
    }
    return side.overlayOpen ? "overlay" : "folded";
  };
  const l = place("left", left);
  return { modes: { left: l, right: place("right", right) }, widths };
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

  const { modes, widths: shownWidths } = composerSidebarLayout(
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

  // What the panels are called in their Show and Hide buttons: their plugins' names.
  const nameOf = (offers: readonly { pluginId: string }[]) =>
    offers.map((o) => getActivePlugin(o.pluginId)?.plugin.name).filter((n): n is string => !!n).join(", ") || null;
  const names: Record<ComposerSidebarSide, string | null> = { left: nameOf(leftOffers), right: nameOf(rightOffers) };

  // The widths the panels are shown at: a docked one may be narrower than
  // the user's, to leave the composer its room.
  return { modes, open, close, toggle, focusRequests, widths: shownWidths, setSideWidth, names };
}

/** Open beside the composer or over it: on screen, with a head in the header row. */
export function isPanelOpen(mode: ComposerSidebarMode | null): boolean {
  return mode === "docked" || mode === "overlay";
}

/** The Show or Hide button of one panel. */
function PanelButton({ side, open, name, onToggle, className }: {
  side: ComposerSidebarSide;
  open: boolean;
  name: string | null;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations("composer_panel");
  const tViewer = useTranslations("email_viewer");
  const label = name
    ? t(open ? "hide_panel" : "show_panel", { name })
    : tViewer(open ? "plugin_panel_hide" : "plugin_panel_show");
  const Icon = side === "left" ? (open ? PanelLeftClose : PanelLeftOpen) : (open ? PanelRightClose : PanelRightOpen);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn("hidden md:grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", className)}
      title={label}
      aria-label={label}
      aria-expanded={open}
      data-composer-panel-toggle={side}
      data-composer-panel-hide={open ? side : undefined}
    >
      <Icon className="h-4 w-4 rtl:-scale-x-100" />
    </button>
  );
}

/**
 * The button in the composer's header that brings a folded panel back (none
 * on phones). An open panel's Hide button is in its head instead
 * (ComposerPanelHead).
 */
export function ComposerPanelToggle({
  side,
  mode,
  name = null,
  onToggle,
  className,
}: {
  side: ComposerSidebarSide;
  mode: ComposerSidebarMode | null;
  name?: string | null;
  onToggle: () => void;
  className?: string;
}) {
  if (mode !== "folded") return null;
  return <PanelButton side={side} open={false} name={name} onToggle={onToggle} className={className} />;
}

/**
 * The part of the composer's header row above an open panel, as wide as the
 * panel: its Hide button at the panel's inner edge, and for the right panel
 * whatever else ends the row (the window buttons, Close last), so they stay
 * at the far end of the composer. On phones there are no panels, and no head.
 */
export function ComposerPanelHead({
  side,
  mode,
  width = COMPOSER_SIDEBAR_WIDTH,
  name = null,
  onToggle,
  className,
  childrenClassName,
  children,
}: {
  side: ComposerSidebarSide;
  mode: ComposerSidebarMode | null;
  width?: number;
  name?: string | null;
  onToggle: () => void;
  /** Padding of the row it is part of. */
  className?: string;
  /** The gap between what it holds besides Hide, as in the row it is part of. */
  childrenClassName?: string;
  children?: ReactNode;
}) {
  if (!isPanelOpen(mode)) return null;
  const hide = <PanelButton side={side} open name={name} onToggle={onToggle} />;
  return (
    <div
      className={cn(
        // Below md, where panels aren't shown, only what it holds besides Hide
        // shows, at the end of the row (one laid over a composer that got narrower).
        "contents md:flex shrink-0 items-center self-stretch border-border",
        side === "left" ? "border-e" : "border-s",
        className,
      )}
      // At least a docked panel's width, so Hide sits at the panel's edge; more
      // when the buttons need it (a narrow panel in the desktop app, beside its
      // controls). One beside the composer or over its text isn't under the
      // header: the head is only its buttons then.
      style={mode === "docked" ? { minWidth: width } : undefined}
      data-composer-panel-head={side}
    >
      {side === "right" && hide}
      <div className="hidden md:block flex-1" />
      {/* No gap of the head's own around Hide and the space: a 260 px panel in the desktop app has just enough room for the buttons. */}
      {children && <div className={cn("contents md:flex items-center", childrenClassName)}>{children}</div>}
      {side === "left" && hide}
    </div>
  );
}

const COMPOSER_ROOT = '[data-testid="email-composer"]';
/** The last of the composer's own fields: Subject, or To while Subject is folded away. */
const COMPOSER_FIELDS_END = "[data-composer-subject]";
const COMPOSER_FOOTER = "[data-composer-footer]";
/** Space kept between a panel beside the composer and the window's edge. */
const BESIDE_MARGIN = 8;

type OverlayPlacement =
  /** Beside the composer, outside it (over the message list), in window coordinates. */
  | { kind: "beside"; left: number; top: number; height: number }
  /** Over the message's text: below the fields, above the bottom bar. */
  | { kind: "over-text"; top: number; bottom: number };

/**
 * Where a panel that has no room in the composer goes: beside it where the
 * window has the room (its own side first), else over the message's text.
 * It used to lie over the composer's right part, From, Cc and Bcc included.
 */
function useOverlayPlacement(active: boolean, panelRef: RefObject<HTMLElement | null>, side: ComposerSidebarSide, width: number): OverlayPlacement | null {
  const [placement, setPlacement] = useState<OverlayPlacement | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const area = panel?.parentElement;
    const root = panel?.closest<HTMLElement>(COMPOSER_ROOT) ?? area;
    if (!active || !panel || !area || !root) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const box = root.getBoundingClientRect();
      const viewport = typeof window !== "undefined" ? window.innerWidth : 0;
      const roomBefore = box.left - BESIDE_MARGIN;
      const roomAfter = viewport - box.right - BESIDE_MARGIN;
      const rtl = getComputedStyle(root).direction === "rtl";
      // The panel's own side of the composer first (the end side is the right in LTR).
      const ownAfter = (side === "right") !== rtl;
      const fitsAfter = roomAfter >= width;
      const fitsBefore = roomBefore >= width;
      let next: OverlayPlacement;
      if ((ownAfter && fitsAfter) || (!fitsBefore && fitsAfter)) {
        next = { kind: "beside", left: Math.round(box.right), top: Math.round(box.top), height: Math.round(box.height) };
      } else if (fitsBefore) {
        next = { kind: "beside", left: Math.round(box.left - width), top: Math.round(box.top), height: Math.round(box.height) };
      } else {
        const areaBox = area.getBoundingClientRect();
        const fieldsEnd = [...root.querySelectorAll<HTMLElement>(`${COMPOSER_FIELDS_END}, [data-composer-to-row]`)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0)
          .reduce((end, r) => Math.max(end, r.bottom), areaBox.top);
        const footer = root.querySelector(COMPOSER_FOOTER);
        const top = Math.max(0, Math.round(fieldsEnd - areaBox.top));
        const bottom = footer ? Math.max(0, Math.round(areaBox.bottom - footer.getBoundingClientRect().top)) : 0;
        next = { kind: "over-text", top, bottom };
      }
      setPlacement((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [active, panelRef, side, width]);

  // `fixed` is relative to the window only without a transformed ancestor:
  // correct by what was really drawn.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || placement?.kind !== "beside") return;
    const drawn = panel.getBoundingClientRect();
    const dx = Math.round(drawn.left - placement.left);
    const dy = Math.round(drawn.top - placement.top);
    if (dx !== 0 || dy !== 0) {
      panel.style.left = `${placement.left - dx}px`;
      panel.style.top = `${placement.top - dy}px`;
    }
  }, [placement, panelRef]);
  return placement;
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
  const placement = useOverlayPlacement(mode === "overlay", panelRef, side, width);
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
        mode !== "overlay"
          ? "h-full"
          : placement?.kind === "beside"
            ? "fixed z-40 shadow-xl rounded-md border"
            : cn("absolute z-30 shadow-xl", side === "left" ? "start-0" : "end-0"),
      )}
      style={mode !== "overlay"
        ? { width }
        : placement?.kind === "beside"
          ? { width, left: placement.left, top: placement.top, height: placement.height }
          : { width, top: placement?.top ?? 0, bottom: placement?.bottom ?? 0 }}
      data-composer-sidebar={side}
      data-composer-sidebar-mode={mode}
      data-composer-sidebar-place={mode === "overlay" ? placement?.kind : undefined}
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
