'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName, Puzzle, X, type AppIcon } from '@/components/icons';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { useCloseBesideControls } from '@/hooks/use-close-beside-controls';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { onPanelRequest } from '@/lib/plugin-sandbox/panel-requests';
import { sidePanelLooks, subscribeSidePanels } from '@/lib/plugin-sandbox/side-panels';
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
  const [focusRequest, setFocusRequest] = useState(0);
  // A plugin that went away (disabled, removed) leaves its panel shut.
  const open = chosen && entries.some((e) => e.pluginId === chosen) ? chosen : null;
  const choose = useCallback((pluginId: string | null) => {
    setChosen(pluginId);
    writeStored(pluginId);
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
      setFocusRequest((n) => n + 1);
      state.current.onOpen?.();
    } else if (isOpen) {
      choose(null);
    }
    return wantOpen;
  }), [choose]);
  return { entries, open, choose, focusRequest };
}

/** A plugin's panel: the host's header (title, close) over the plugin's frame, which fills the rest. */
export function PluginSidePanelBody({ entry, focusRequest, onClose }: {
  entry: SidePanelEntry;
  focusRequest: number;
  onClose: () => void;
}) {
  const tCommon = useTranslations('common');
  const extraProps = useMemo(() => ({ focusRequest }), [focusRequest]);
  // Right under the window's own close, at the window's end: this one goes to the start.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(head);
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
      <div
        data-plugin-slot="side-panel"
        className={cn('min-h-0 flex-1', entry.fill ? 'flex flex-col' : 'overflow-y-auto')}
      >
        <PluginIframeSlot key={entry.pluginId} pluginId={entry.pluginId} slot="side-panel" extraProps={extraProps} fill={entry.fill} />
      </div>
    </>
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
