'use client';

// The plugin side panel of Calendar, Contacts, Files and Settings (slot
// app-side-panel), built like the reader's (email-viewer.tsx): one button at
// the end of the view's h-14 toolbar row shows and hides it, it can be
// dragged between 200 and 500 px, and it lies over the view instead of
// squeezing it when the view would get too narrow. Its width and whether it
// is folded are kept in localStorage for all four views. Until the user
// folds or opens it, a plugin that asked to start folded starts folded.
// Only a plugin whose shouldShow says yes gets the button and the panel.
//
// Each view mounts its own panel, so the frame starts over when the user
// switches views; the plugin keeps what it needs in its storage. In the Pro
// shell's panes there is none (only a Mail pane's reader panel).
//
// Phones, and Settings below 1024 px (phone-shaped there), have no room for
// a panel: a button in the phone header (PhoneHeaderActions, and Contacts'
// row over an open contact) asks the plugin for its dialog instead, through
// its onAction hook (surface `app-side-panel`, actionId `open`, context
// { view, context }), and so does api.ui.openPanel there.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PanelRightClose, PanelRightOpen } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ResizeHandle } from '@/components/layout/resize-handle';
import { PluginSlot } from '@/components/plugins/plugin-slot';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { useIsMobile } from '@/hooks/use-media-query';
import { onPanelRequest } from '@/lib/plugin-sandbox/panel-requests';
import { runPluginAction } from '@/lib/plugin-sandbox/actions';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { slotPropsFor } from '@/lib/plugin-sandbox/permissions';
import { shortcutKeysFor } from '@/lib/plugin-sandbox/shortcuts';
import type { AppSidePanelContext, AppSidePanelViewName } from '@/lib/plugin-sandbox/assistant/f.types';
import { cn } from '@/lib/utils';

export const APP_SIDE_PANEL_SLOT = 'app-side-panel';
export const APP_SIDE_PANEL_MIN_WIDTH = 200;
export const APP_SIDE_PANEL_MAX_WIDTH = 500;
export const APP_SIDE_PANEL_DEFAULT_WIDTH = 280;
/** The view keeps at least this much room next to a docked panel; with less the panel lies over it. */
export const APP_SIDE_PANEL_MIN_CONTENT = 480;
export const APP_SIDE_PANEL_COLLAPSED_KEY = 'appSidePanelCollapsed';
export const APP_SIDE_PANEL_WIDTH_KEY = 'appSidePanelWidth';
/** The id of a plugin shortcut that opens and closes its panel; its keys go into the button's title. */
export const PANEL_SHORTCUT_ID = 'toggle-panel';

const clampWidth = (n: number) => Math.max(APP_SIDE_PANEL_MIN_WIDTH, Math.min(APP_SIDE_PANEL_MAX_WIDTH, n));

/**
 * The button that shows and hides a plugin side panel, the same in the
 * reader and in every other view: at the end of the toolbar row above the
 * panel. One name ("Plugin panel"); aria-pressed says whether it is open.
 * `shortcut`: the keys of the plugin's own shortcut for its panel.
 */
export function PluginPanelToggle({ open, onClick, className, buttonRef, shortcut }: {
  open: boolean;
  onClick: () => void;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  shortcut?: string | null;
}) {
  const t = useTranslations('email_viewer');
  const label = t('plugin_panel');
  return (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={cn('h-8 w-8 shrink-0', className)}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={open}
      aria-keyshortcuts={shortcut ?? undefined}
      data-plugin-panel-toggle=""
    >
      {open ? <PanelRightClose className="w-4 h-4 text-muted-foreground rtl:-scale-x-100" /> : <PanelRightOpen className="w-4 h-4 text-muted-foreground rtl:-scale-x-100" />}
    </Button>
  );
}

/** The keys of the panel shortcut of the first of these plugins that has one ("Alt+A"), or null. */
export function panelShortcutOf(pluginIds: string[]): string | null {
  for (const id of pluginIds) {
    const keys = shortcutKeysFor(id, PANEL_SHORTCUT_ID);
    if (keys) return keys;
  }
  return null;
}

/** The panel's name for screen readers: its plugins' names, else "Plugin panel". */
export function panelLabelOf(pluginIds: string[], fallback: string): string {
  const names = pluginIds.map((id) => getActivePlugin(id)?.plugin.name).filter((n): n is string => !!n);
  return names.length ? names.join(', ') : fallback;
}

// ─── Where the panel can't dock: the plugin's dialog ───────────────

export interface AppSidePanelDialogEntry {
  pluginId: string;
  view: AppSidePanelViewName;
  context: AppSidePanelContext;
}

let dialogEntry: AppSidePanelDialogEntry | null = null;
const dialogListeners = new Set<() => void>();

function setDialogEntry(entry: AppSidePanelDialogEntry | null) {
  dialogEntry = entry;
  for (const listener of dialogListeners) listener();
}

function subscribeDialogEntry(listener: () => void) {
  dialogListeners.add(listener);
  return () => { dialogListeners.delete(listener); };
}

/** The view whose plugin panel opens as a dialog right now (a phone), or null. */
export function useAppSidePanelDialogEntry(): AppSidePanelDialogEntry | null {
  return useSyncExternalStore(subscribeDialogEntry, () => dialogEntry, () => null);
}

/** Asks the plugin for its dialog with what the view shows (the context is cut to its permissions on the way). */
export function openAppSidePanelDialog(entry: AppSidePanelDialogEntry, pluginId = entry.pluginId): void {
  void runPluginAction(pluginId, APP_SIDE_PANEL_SLOT, 'open', { view: entry.view, context: entry.context }).catch(() => {});
}

/** The phone's button for the view's plugin panel, which opens as a dialog there. */
export function AppSidePanelPhoneButton({ className }: { className?: string } = {}) {
  const t = useTranslations('email_viewer');
  const entry = useAppSidePanelDialogEntry();
  if (!entry) return null;
  return (
    <IconButton
      size="icon-lg"
      label={t('plugin_panel_show')}
      onClick={() => openAppSidePanelDialog(entry)}
      className={className}
      data-app-side-panel-phone=""
    >
      <PanelRightOpen />
    </IconButton>
  );
}

// ─── Which plugins show it ─────────────────────────────────────────

/**
 * The plugins whose offer of the panel shows here: each one's shouldShow
 * (asked in its background frame with the props it may see) said yes, or it
 * has none. Until a plugin answers its offer doesn't count, so a plugin that
 * is switched off for these views never gets a button that opens nothing.
 */
function useShownPluginIds(pluginOffers: readonly { pluginId: string; hasShouldShow: boolean }[], view: AppSidePanelViewName, context: AppSidePanelContext): string[] {
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const key = pluginOffers.map((o) => `${o.pluginId}:${o.hasShouldShow ? 1 : 0}`).join(',');
  useEffect(() => {
    let live = true;
    for (const offer of pluginOffers) {
      const active = getActivePlugin(offer.pluginId);
      if (!offer.hasShouldShow || !active?.background?.evaluateShouldShow) {
        setAnswers((prev) => (prev[offer.pluginId] === true ? prev : { ...prev, [offer.pluginId]: true }));
        continue;
      }
      const props = slotPropsFor(active.plugin, APP_SIDE_PANEL_SLOT, { view, context });
      active.background.evaluateShouldShow(APP_SIDE_PANEL_SLOT, props)
        .then((show) => { if (live) setAnswers((prev) => (prev[offer.pluginId] === show ? prev : { ...prev, [offer.pluginId]: show })); })
        .catch(() => { if (live) setAnswers((prev) => ({ ...prev, [offer.pluginId]: false })); });
    }
    return () => { live = false; };
    // The offers by their key; a new context asks again (the plugin may decide by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, view, context]);
  return useMemo(() => pluginOffers.filter((o) => answers[o.pluginId] === true).map((o) => o.pluginId), [pluginOffers, answers]);
}

// ─── The panel ─────────────────────────────────────────────────────

export interface UseAppSidePanelOptions {
  view: AppSidePanelViewName;
  /** What the view shows; keep it memoised, a new object is sent to the plugin. */
  context: AppSidePanelContext;
  /** False where the view has no room for a panel at any width it is in now (Settings below 1024 px): the dialog then. */
  dock?: boolean;
  /**
   * Folded here for now without changing the stored choice (Files while its
   * details panel is open), so the other views keep the panel as the user left it.
   */
  hidden?: boolean;
  /** Called when the panel opens, so the view can fold a panel it shares the place with (Files' details). */
  onOpen?: () => void;
}

export interface AppSidePanel {
  /** A plugin shows the panel here (outside the Pro shell's panes). */
  offered: boolean;
  /** The panel docks in this view now (else it is a dialog, or nothing). */
  docks: boolean;
  /** Whether the docked panel is open. */
  open: boolean;
  /** Whether the user's choice is to have it open (also while `hidden` folds it here). */
  wantsOpen: boolean;
  /** The button for the end of the toolbar row, or null. */
  toggle: ReactNode;
  /** The resize handle and the panel, as the last children of the row it sits in; null while folded. */
  panel: ReactNode;
  /** Put on the row the panel sits in: its width decides docked or over the view. */
  rowRef: (el: HTMLElement | null) => void;
  /** Folds the panel and keeps it folded. */
  close: () => void;
}

function readChoice(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(APP_SIDE_PANEL_COLLAPSED_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch { return null; }
}

function readWidth(): number {
  if (typeof window === 'undefined') return APP_SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const n = parseInt(localStorage.getItem(APP_SIDE_PANEL_WIDTH_KEY) ?? '', 10);
    return Number.isFinite(n) ? clampWidth(n) : APP_SIDE_PANEL_DEFAULT_WIDTH;
  } catch { return APP_SIDE_PANEL_DEFAULT_WIDTH; }
}

export function useAppSidePanel({ view, context, dock = true, hidden = false, onOpen }: UseAppSidePanelOptions): AppSidePanel {
  const t = useTranslations('email_viewer');
  const isEmbedded = useIsEmbedded();
  const isMobile = useIsMobile();
  const offers = usePluginSlotOffers(APP_SIDE_PANEL_SLOT);
  const shownIds = useShownPluginIds(isEmbedded ? [] : offers, view, context);
  const offered = shownIds.length > 0 && !isEmbedded;
  const docks = offered && dock && !isMobile;
  const asDialog = offered && !docks;

  const [choice, setChoice] = useState<boolean | null>(readChoice);
  const [width, setWidth] = useState<number>(readWidth);
  const widthAtStart = useRef(width);
  const [forcedOpen, setForcedOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [rowEl, setRowEl] = useState<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!docks || !rowEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setRowWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(rowEl);
    return () => ro.disconnect();
  }, [docks, rowEl]);

  const collapsed = choice ?? offers.some((o) => o.startFolded && shownIds.includes(o.pluginId));
  const tooNarrow = rowWidth > 0 && rowWidth - width < APP_SIDE_PANEL_MIN_CONTENT;
  const folded = collapsed || hidden || (tooNarrow && !forcedOpen);
  const overlay = !folded && tooNarrow;
  // Docked, the panel grows only as far as the view keeps its room: a drag
  // or the arrow keys stop there instead of folding the panel away.
  const dockedMax = rowWidth > 0 ? Math.max(APP_SIDE_PANEL_MIN_WIDTH, rowWidth - APP_SIDE_PANEL_MIN_CONTENT) : APP_SIDE_PANEL_MAX_WIDTH;

  useEffect(() => {
    if (choice === null) return;
    try { localStorage.setItem(APP_SIDE_PANEL_COLLAPSED_KEY, choice ? '1' : '0'); } catch { /* ignore */ }
  }, [choice]);
  useEffect(() => {
    try { localStorage.setItem(APP_SIDE_PANEL_WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const state = useRef({ offered, docks, folded, tooNarrow, view, context, pluginId: shownIds[0] ?? null });
  state.current = { offered, docks, folded, tooNarrow, view, context, pluginId: shownIds[0] ?? null };

  const setOpen = useCallback((want: boolean) => {
    const now = state.current;
    if (want) {
      setChoice(false);
      if (now.tooNarrow) setForcedOpen(true);
      // Opening on request puts the focus in the panel (the plugin's input).
      setFocusRequest((n) => n + 1);
      onOpenRef.current?.();
    } else {
      // Focus in the panel goes back to the button, not to the page's start.
      const hadFocus = !!panelRef.current && panelRef.current.contains(document.activeElement);
      setChoice(true);
      setForcedOpen(false);
      if (hadFocus) requestAnimationFrame(() => toggleRef.current?.focus());
    }
  }, []);

  const close = useCallback(() => {
    if (!state.current.folded) setOpen(false);
  }, [setOpen]);

  // api.ui.openPanel / closePanel / togglePanel for this slot.
  useEffect(() => onPanelRequest((request) => {
    if (request.slot !== APP_SIDE_PANEL_SLOT) return null;
    const now = state.current;
    if (!now.offered) return null;
    if (!now.docks) {
      // No room for a panel: the plugin that asked gets the open request
      // for its dialog, and the panel itself stays closed.
      if (request.mode !== 'close') openAppSidePanelDialog({ pluginId: request.pluginId, view: now.view, context: now.context });
      return false;
    }
    const want = request.mode === 'open' ? true : request.mode === 'close' ? false : now.folded;
    setOpen(want);
    return want;
  }), [setOpen]);

  // The phone button, while this view's panel is a dialog.
  const firstPluginId = shownIds[0] ?? null;
  useEffect(() => {
    if (!asDialog || !firstPluginId) return;
    setDialogEntry({ pluginId: firstPluginId, view, context });
    return () => setDialogEntry(null);
  }, [asDialog, firstPluginId, view, context]);

  const toggle = docks ? (
    <PluginPanelToggle open={!folded} onClick={() => setOpen(folded)} buttonRef={toggleRef} shortcut={panelShortcutOf(shownIds)} />
  ) : null;

  const panel = docks && !folded ? (
    <>
      {!overlay && (
        <ResizeHandle
          pane="sidePanel"
          value={width}
          min={APP_SIDE_PANEL_MIN_WIDTH}
          max={Math.min(APP_SIDE_PANEL_MAX_WIDTH, dockedMax)}
          onResizeStart={() => { widthAtStart.current = width; }}
          // The panel is on the right: dragging left makes it wider.
          onResize={(delta) => setWidth(clampWidth(Math.min(dockedMax, widthAtStart.current - delta)))}
          onResizeEnd={() => { widthAtStart.current = width; }}
          onDoubleClick={() => setWidth(Math.min(dockedMax, APP_SIDE_PANEL_DEFAULT_WIDTH))}
        />
      )}
      <div
        ref={panelRef}
        role="complementary"
        aria-label={panelLabelOf(shownIds, t('plugin_panel'))}
        data-app-side-panel={overlay ? 'overlay' : 'docked'}
        data-app-side-panel-view={view}
        data-window-end-column=""
        className={cn(
          'flex flex-col h-full border-s border-border bg-background overflow-hidden shrink-0',
          overlay && 'absolute inset-y-0 end-0 z-30 shadow-xl',
        )}
        style={overlay
          ? { width: Math.min(width, Math.max(APP_SIDE_PANEL_MIN_WIDTH, rowWidth - 48)) }
          : { width, minWidth: width }}
      >
        <div className="flex-1 min-h-0 overflow-y-auto">
          <PluginSlot name="app-side-panel" extraProps={{ view, context, focusRequest }} />
        </div>
      </div>
    </>
  ) : null;

  return { offered, docks, open: docks && !folded, wantsOpen: docks && !collapsed, toggle, panel, rowRef: setRowEl, close };
}
