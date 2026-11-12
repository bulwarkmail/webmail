'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName, Puzzle, X, type AppIcon } from '@/components/icons';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { useCloseBesideControls } from '@/hooks/use-close-beside-controls';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { onPanelRequest } from '@/lib/plugin-sandbox/panel-requests';
import {
  leaveSidePanelFrame,
  requestSidePanelFocus,
  setSidePanelFrame,
  sidePanelFocusRequest,
  sidePanelFrame,
  sidePanelLooks,
  subscribeSidePanelFrame,
  subscribeSidePanels,
} from '@/lib/plugin-sandbox/side-panels';
import { cn } from '@/lib/utils';
import { PluginIframeSlot } from './plugin-iframe-slot';

// The `side-panel` slot: one panel per plugin beside the mail and beside a
// plugin's pages (plugin-page-app.tsx), opened from
// its button in the rail at the right edge. Mountain View puts the buttons
// in its own side panel's rail (mv-side-panel.tsx); the default layout
// shows PluginSidePanel. At most one panel is open; which one is
// remembered in this browser. A plugin that set `rail: false` has no
// button: its panel opens only on its request; a rail without buttons is
// not drawn.
//
// The open panel's frame outlives the view drawing the panel: going from the
// mail to a plugin page and back would start the plugin anew, and a frame
// moved in the DOM loads anew too. So PluginSidePanelFrame, once in the
// layout, keeps it and lays it over the slot of the panel on screen; with
// none (calendar, settings) the frame is hidden, still running, until the
// panel shows again or is closed.

const STORAGE_KEY = 'plugin-side-panel-open';

export interface SidePanelEntry {
  pluginId: string;
  title: string;
  Icon: AppIcon;
  fill: boolean;
  /** Whether the rail shows its button (api.ui.setSidePanel's `rail`). */
  inRail: boolean;
}

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeStored(pluginId: string | null): void {
  try {
    if (pluginId) localStorage.setItem(STORAGE_KEY, pluginId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked; the panel is just shut next time.
  }
}

/** The plugins offering a side panel, each with the title and icon it set (api.ui.setSidePanel). */
export function usePluginSidePanelEntries(): SidePanelEntry[] {
  const offers = usePluginSlotOffers('side-panel');
  const looks = useSyncExternalStore(subscribeSidePanels, sidePanelLooks, sidePanelLooks);
  return useMemo(() => {
    return offers.map((offer) => {
      const look = looks.get(offer.pluginId);
      return {
        pluginId: offer.pluginId,
        title: look?.title || getActivePlugin(offer.pluginId)?.plugin.name || offer.pluginId,
        Icon: iconForName(look?.icon) ?? Puzzle,
        fill: !!offer.fill,
        inRail: look?.rail !== false,
      };
    });
  }, [offers, looks]);
}

/**
 * Which plugin's side panel is open (null: none), remembered in this
 * browser, and the plugins' api.ui.openPanel('side-panel') requests;
 * `onOpen` runs when a plugin's request opens its panel.
 */
export function usePluginSidePanel(onOpen?: () => void) {
  const entries = usePluginSidePanelEntries();
  const [chosen, setChosen] = useState<string | null>(readStored);
  const focusRequest = useSyncExternalStore(subscribeSidePanelFrame, sidePanelFocusRequest, sidePanelFocusRequest);
  // A plugin that went away (disabled, removed) leaves its panel shut.
  const open = chosen && entries.some((e) => e.pluginId === chosen) ? chosen : null;
  const choose = useCallback((pluginId: string | null) => {
    setChosen(pluginId);
    writeStored(pluginId);
    // Closed, or another plugin's: the kept frame ends.
    if (sidePanelFrame()?.pluginId !== pluginId) setSidePanelFrame(null);
  }, []);
  const state = useRef({ entries, open, onOpen });
  state.current = { entries, open, onOpen };
  useEffect(() => onPanelRequest((request) => {
    if (request.slot !== 'side-panel') return null;
    if (!state.current.entries.some((e) => e.pluginId === request.pluginId)) return null;
    const isOpen = state.current.open === request.pluginId;
    const wantOpen = request.mode === 'open' ? true : request.mode === 'close' ? false : !isOpen;
    if (wantOpen) {
      choose(request.pluginId);
      requestSidePanelFocus();
      state.current.onOpen?.();
    } else if (isOpen) {
      choose(null);
    }
    return wantOpen;
  }), [choose]);
  return { entries, open, choose, focusRequest };
}

/** A plugin's panel: the host's header (title, close) over the plugin's frame (PluginSidePanelFrame), which fills the rest. */
export function PluginSidePanelBody({ entry, focusRequest, onClose }: {
  entry: SidePanelEntry;
  focusRequest: number;
  onClose: () => void;
}) {
  const tCommon = useTranslations('common');
  // Right under the window's own close, at the window's end: this one goes to the start.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(head);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (slot) setSidePanelFrame({ pluginId: entry.pluginId, fill: entry.fill, focusRequest, slot });
  }, [slot, entry.pluginId, entry.fill, focusRequest]);
  // Gone from the screen, the panel leaves its frame running, hidden.
  useLayoutEffect(() => () => {
    if (slot) leaveSidePanelFrame(slot);
  }, [slot]);
  const close = (
    <button
      type="button"
      onClick={onClose}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      title={tCommon('close')}
      aria-label={tCommon('close')}
    >
      <X className="h-4 w-4" />
    </button>
  );
  return (
    <>
      <div ref={setHead} data-window-pane-head="" className={cn("flex shrink-0 items-center gap-1 pt-3 pb-1", closeFirst ? "ps-2 pe-4" : "ps-4 pe-2")}>
        {closeFirst && close}
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{entry.title}</div>
        {!closeFirst && close}
      </div>
      <div ref={setSlot} data-plugin-slot="side-panel" aria-owns={FRAME_ID} className="min-h-0 flex-1" />
    </>
  );
}

const FRAME_ID = 'plugin-side-panel-frame';
const noFrame = () => null;

type Box = Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>;

/** Where the slot is on screen, followed while it or the window resizes. */
function useSlotBox(slot: HTMLElement | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!slot) {
      setBox(null);
      return;
    }
    const measure = () => {
      const { top, left, width, height } = slot.getBoundingClientRect();
      setBox((prev) => (prev && prev.top === top && prev.left === left && prev.width === width && prev.height === height
        ? prev
        : { top, left, width, height }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slot);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [slot]);
  return box;
}

/**
 * The open side panel's frame, rendered once in the layout: laid over the
 * slot of the panel on screen (PluginSidePanelBody), hidden without one.
 */
export function PluginSidePanelFrame() {
  const frame = useSyncExternalStore(subscribeSidePanelFrame, sidePanelFrame, noFrame);
  const offers = usePluginSlotOffers('side-panel');
  const box = useSlotBox(frame?.slot ?? null);
  const focusRequest = frame?.focusRequest ?? 0;
  const extraProps = useMemo(() => ({ focusRequest }), [focusRequest]);
  // A plugin that went away takes its frame along.
  if (!frame || !offers.some((o) => o.pluginId === frame.pluginId)) return null;
  return (
    <div
      id={FRAME_ID}
      data-plugin-side-panel-frame={frame.pluginId}
      className={cn('fixed', frame.fill ? 'flex flex-col' : 'overflow-y-auto', !(frame.slot && box) && 'hidden')}
      style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined}
    >
      <PluginIframeSlot key={frame.pluginId} pluginId={frame.pluginId} slot="side-panel" extraProps={extraProps} fill={frame.fill} />
    </div>
  );
}

/**
 * The default layout's side panel: a slim rail at the right edge with a
 * button per plugin, and the open plugin's panel left of it. Nothing
 * without a plugin offering one.
 */
export function PluginSidePanel() {
  const t = useTranslations('sidebar');
  const { entries, open, choose, focusRequest } = usePluginSidePanel();
  if (entries.length === 0) return null;
  const active = entries.find((e) => e.pluginId === open) ?? null;
  const inRail = entries.filter((e) => e.inRail);
  return (
    <>
      {active && (
        <aside
          data-plugin-side-panel={active.pluginId}
          data-window-end-column=""
          className="flex w-[300px] shrink-0 flex-col overflow-hidden border-s border-border bg-background"
          aria-label={active.title}
        >
          <PluginSidePanelBody entry={active} focusRequest={focusRequest} onClose={() => choose(null)} />
        </aside>
      )}
      {inRail.length > 0 && <nav
        data-plugin-side-rail=""
        data-window-end-column=""
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-s border-border bg-background pt-2"
        aria-label={t('mv_side_panel')}
      >
        {inRail.map((entry) => (
          <SidePanelButton
            key={entry.pluginId}
            entry={entry}
            pressed={open === entry.pluginId}
            onClick={() => choose(open === entry.pluginId ? null : entry.pluginId)}
            className="h-9 w-9 rounded-md hover:bg-muted"
            pressedClassName="bg-muted text-foreground"
          />
        ))}
      </nav>}
    </>
  );
}

/** A plugin's button in a side panel's rail. */
export function SidePanelButton({ entry, pressed, onClick, className, pressedClassName }: {
  entry: SidePanelEntry;
  pressed: boolean;
  onClick: () => void;
  className?: string;
  pressedClassName?: string;
}) {
  const { Icon } = entry;
  return (
    <button
      type="button"
      onClick={onClick}
      data-plugin-side-panel-button={entry.pluginId}
      className={cn('grid place-items-center text-muted-foreground transition-colors', className, pressed && pressedClassName)}
      title={entry.title}
      aria-label={entry.title}
      aria-pressed={pressed}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
