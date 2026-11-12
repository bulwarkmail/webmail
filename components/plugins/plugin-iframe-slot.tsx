'use client';

// Sandboxed slot mount. One iframe per (plugin, slot) - created lazily after
// the background instance confirms `shouldShow(context)` (if defined). The
// iframe renders the plugin's slot component using the plugin's bundle in a
// null-origin context; its height is pushed back via postMessage and applied
// to a wrapper <div>.
//
// A frame may ask the host to draw a dropdown list for it (the UI kit's
// Combobox). The host draws it in its own document, so it keeps to the frame:
// it draws a frame's list only while the user is in that frame (the frame has
// the focus, see FrameFocus), and never while a menu, popover or dialog of the
// app is open that the frame is not inside (a question the host asks about the
// plugin, an app dialog, a plugin's prompt on top of its own dialog, the menu
// beside a banner that turns the plugin off); an open list closes when either
// stops being so. Only a frame that is drawn with a real size gets one; it
// stands in the part of the window the frame takes up, plus its own height; it
// never covers a row where the host names a plugin (a dialog's header, a
// banner's name chip) or a part of the app marked with LIST_AVOID_ATTRIBUTE
// (the reader's subject, sender, details and trust banners, the top bar), and
// isn't drawn where it can't keep clear of them with room for two options; in
// a plugin's dialog it stays below the frame's top; its first row names the
// plugin; it is drawn in the layer of the plugin
// dialog the frame is in. It closes on any click outside it, on scrolling, on
// resizing, and when the frame stops showing.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { SlotName } from '@/lib/plugin-types';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import type { SandboxInstance } from '@/lib/plugin-sandbox/host-bridge';
import { loadHostBridge } from '@/lib/plugin-sandbox/load-host-bridge';
import type { FloatingDropdownOption, FloatingDropdownRect } from '@/lib/plugin-sandbox/protocol';
import { slotPropsFor } from '@/lib/plugin-sandbox/permissions';
import { isFillableSlot, isInlineSlot, maxSlotHeight } from '@/lib/plugin-sandbox/slot-layout';
import { snapshotHostTheme } from '@/lib/plugin-sandbox/host-theme';
import { useThemeStore } from '@/stores/theme-store';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { ContextMenu, ContextMenuHeader, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { Check, Power, Puzzle } from '@/components/icons';
import { cn } from '@/lib/utils';

interface Props {
  pluginId: string;
  slot: SlotName;
  extraProps?: Record<string, unknown>;
  /**
   * The frame fills its panel and scrolls inside, instead of growing with its
   * content. Only in a slot made for that (slot-layout.ts FILLABLE_SLOTS).
   */
  fill?: boolean;
  /** With `fill`: the height the frame keeps however little room its panel has. */
  minFillHeight?: number;
  /**
   * Told whether the frame is up: false when the plugin's shouldShow says no
   * or its frame fails to start, true once it has started. For a slot that
   * stands in for a part of Bulwark (calendar-task-view), so the caller can
   * draw its own part again.
   */
  onShownChange?: (shown: boolean) => void;
  /** Told the frame's height (as the host sizes it) whenever it changes. */
  onHeightChange?: (height: number) => void;
}

interface FloatingDropdownState {
  id: string;
  rect: FloatingDropdownRect;
  options: FloatingDropdownOption[];
  multiple?: boolean;
  selectedValues: string[];
  singleValue?: string;
  highlightedIndex: number;
  ariaLabel?: string;
}

/**
 * The host's open layers: its dialogs, the app's own and the plugins' alike
 * (modal or a popover like the event details), and its menus (ContextMenu and
 * the menus the app draws itself). They are in the document while open; one
 * kept there while closed is inert or hidden.
 */
const OPEN_LAYER_SELECTOR = '[aria-modal="true"], [role="alertdialog"], [role="dialog"], [role="menu"]';
/**
 * The button of an open popup. It also stands for a picker whose list has no
 * menu or dialog role of its own (searchable-select.tsx, the composer's menus).
 */
const OPEN_POPUP_BUTTON_SELECTOR = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]';

/** A layer kept in the page while closed: the phone's reader menu slides out and turns inert. */
function isOpenLayer(el: Element): boolean {
  if (el.closest('[inert], [hidden]')) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (getComputedStyle(n).display === 'none') return false;
  }
  return true;
}

/**
 * Whether a dialog, popover or menu of the host is open that `el` is not
 * inside. A list drawn for a frame in `el` would then lie over it, and it may
 * be the host asking about this very plugin or the menu that turns it off.
 */
export function hostLayerOutside(el: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  if (!el) return true;
  for (const layer of document.querySelectorAll(OPEN_LAYER_SELECTOR)) {
    if (!layer.contains(el) && isOpenLayer(layer)) return true;
  }
  // A frame inside a menu or a dialog is in the popup that the open button
  // stands for; any other open popup has its own layer above.
  if (!el.closest(OPEN_LAYER_SELECTOR)) {
    for (const button of document.querySelectorAll(OPEN_POPUP_BUTTON_SELECTOR)) {
      if (isOpenLayer(button)) return true;
    }
  }
  return false;
}

/** Whether the frame shows: drawn, with some of it in the window. */
function frameShows(el: Element): boolean {
  if (!isDrawn(el)) return false;
  const area = shownArea(el);
  return area.right > area.left && area.bottom > area.top;
}

interface FocusStay {
  /** The focus was seen coming into the frame from the app, in a focused window, while the frame showed and no menu or dialog of the app was open. */
  counted: boolean;
  /** The user closed the frame's list during this stay, with a click outside it. */
  dismissed: boolean;
}

/** How long a press in the list may take before the focus counts again. */
const PRESS_HOLD_MS = 1000;
/** After the press: time for the frame to put the focus back into its field. */
const PRESS_SETTLE_MS = 300;
/** How often the focus is read while it is in the frame (no event says it left). */
const FOCUS_POLL_MS = 200;

/**
 * Follows the focus for one frame, for the rule that the host draws a frame's
 * list only while the user is in that frame.
 *
 * The user is in the frame while it has the focus: `document.activeElement`
 * is its iframe and the window has the focus. A frame can take the focus by
 * script, so that alone isn't enough. A stay in the frame counts only when
 * the focus was seen coming into it from the app while the app's window had
 * the focus, the frame showed and no menu, popover or dialog of the app was
 * open outside it. A stay that starts otherwise (the window coming back to
 * the front with the frame focused, a frame that took the focus while it
 * showed nothing, or while the menu that turns it off was open) gets no list
 * until the focus has left the frame and come back. A list the user closed with a click outside it isn't
 * drawn again in the same stay.
 *
 * Browsers don't all tell the page when the focus moves into a frame of
 * another origin, and none when it leaves the window from inside one, so the
 * focus is read on the app's focus and input events, when the frame asks, and
 * every 200 ms while it is in the frame.
 */
class FrameFocus {
  private stay: FocusStay | null = null;
  private last: { inFrame: boolean; windowFocused: boolean };
  private holdUntil = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly frame: () => HTMLIFrameElement | null,
    private readonly onLeave: () => void,
    /** A menu, popover or dialog of the app is open that the frame is not inside. */
    private readonly covered: () => boolean,
  ) {
    this.last = { inFrame: false, windowFocused: typeof document !== 'undefined' && document.hasFocus() };
  }

  /** Reads where the focus is now; true while it is in the frame. */
  observe = (): boolean => {
    if (typeof document === 'undefined') return false;
    // A press in the list: the pick goes to the frame first, then the frame
    // puts the focus back into its field.
    if (Date.now() < this.holdUntil) return this.stay !== null;
    const frame = this.frame();
    const windowFocused = document.hasFocus();
    const inFrame = !!frame && windowFocused && document.activeElement === frame;
    if (inFrame) {
      if (!this.stay) {
        // Taking the focus closes an open menu of the app (it closes when
        // the window loses the focus): a stay that starts while one is open
        // doesn't count either.
        this.stay = {
          counted: !this.last.inFrame && this.last.windowFocused && frameShows(frame) && !this.covered(),
          dismissed: false,
        };
        this.poll ??= setInterval(this.observe, FOCUS_POLL_MS);
      }
    } else if (this.stay) {
      this.stay = null;
      this.stopPoll();
      this.onLeave();
    }
    this.last = { inFrame, windowFocused };
    return inFrame;
  };

  /** 'yes' when the frame may have a list now, 'away' when the focus isn't in it. */
  allows(): 'yes' | 'away' | 'no' {
    if (!this.observe()) return 'away';
    return this.stay?.counted && !this.stay.dismissed ? 'yes' : 'no';
  }

  /** The user closed the list: none again until the focus has left the frame and come back. */
  dismiss(): void {
    if (this.stay) this.stay.dismissed = true;
  }

  /** A press in the list starts. */
  hold = (): void => {
    this.holdUntil = Date.now() + PRESS_HOLD_MS;
    this.later(this.observe, PRESS_HOLD_MS + 20);
  };

  /** The press in the list ended (its click went to the frame). */
  release = (): void => {
    this.holdUntil = Date.now() + PRESS_SETTLE_MS;
    this.later(this.observe, PRESS_SETTLE_MS + 20);
  };

  later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  /** Listens to the app's focus and input; returns the cleanup. */
  start(): () => void {
    const now = this.observe;
    // The focus moves after the input event, as its default action.
    const soon = () => this.later(this.observe, 0);
    window.addEventListener('focus', now);
    window.addEventListener('blur', now);
    document.addEventListener('focusin', now, true);
    document.addEventListener('focusout', soon, true);
    document.addEventListener('pointerdown', soon, true);
    document.addEventListener('mousedown', soon, true);
    document.addEventListener('keydown', soon, true);
    return () => {
      window.removeEventListener('focus', now);
      window.removeEventListener('blur', now);
      document.removeEventListener('focusin', now, true);
      document.removeEventListener('focusout', soon, true);
      document.removeEventListener('pointerdown', soon, true);
      document.removeEventListener('mousedown', soon, true);
      document.removeEventListener('keydown', soon, true);
      this.stopPoll();
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
    };
  }

  private stopPoll(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }
}

/** The frame's message can come in before the app hears that the focus moved into it. */
const FOCUS_ARRIVAL_MS = 100;
/** How often an open list checks that its frame still shows. */
const FRAME_CHECK_MS = 250;

export function PluginIframeSlot({ pluginId, slot, extraProps, fill: fillAsked = false, minFillHeight, onShownChange, onHeightChange }: Props) {
  const fill = fillAsked && isFillableSlot(slot);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<SandboxInstance | null>(null);
  const onShownChangeRef = useRef(onShownChange);
  useEffect(() => { onShownChangeRef.current = onShownChange; }, [onShownChange]);
  const onHeightChangeRef = useRef(onHeightChange);
  useEffect(() => { onHeightChangeRef.current = onHeightChange; }, [onHeightChange]);
  const [height, setHeight] = useState<number>(0);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const [floatingDropdown, setFloatingDropdown] = useState<FloatingDropdownState | null>(null);
  const openDropdownRef = useRef<string | null>(null);
  openDropdownRef.current = floatingDropdown?.id ?? null;
  const dropdownStateRef = useRef<FloatingDropdownState | null>(null);
  dropdownStateRef.current = floatingDropdown;
  // Bumped when an open list has to move (what it must not cover moved).
  const [, setPlacementTick] = useState(0);
  // Whether the user is in the frame. When the focus leaves it, its list closes.
  const focusRef = useRef<FrameFocus | null>(null);
  focusRef.current ??= new FrameFocus(
    () => wrapperRef.current?.querySelector('iframe') ?? null,
    () => {
      const id = openDropdownRef.current;
      if (id === null) return;
      instanceRef.current?.sendFloatingDropdownEvent({ type: 'floating-dropdown-dismiss', id });
      setFloatingDropdown((prev) => (prev?.id === id ? null : prev));
    },
    () => hostLayerOutside(wrapperRef.current),
  );
  // A list asked for just before the app heard that the focus moved into the frame.
  const pendingOpenRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const inline = isInlineSlot(slot);
  // null = pending, true/false = decided
  const [show, setShow] = useState<boolean | null>(null);

  // A caller that builds its props inline hands over a new object on every
  // render; each one used to cost a shouldShow round trip to the plugin and a
  // props-update for the frame. Keep the last object while its values are
  // the same ones.
  const [stableProps, setStableProps] = useState(extraProps);
  const sameValues = shallowEqual(stableProps, extraProps);
  if (!sameValues) setStableProps(extraProps);
  const currentProps = sameValues ? stableProps : extraProps;

  // What the plugin may see of the surface the slot sits on. Everything the
  // plugin receives (shouldShow context, mount props, updates) goes through
  // this, so a ui:* permission never hands over mail, events or contacts.
  const props = useMemo(() => {
    const active = getActivePlugin(pluginId);
    return active ? slotPropsFor(active.plugin, slot, currentProps ?? {}) : {};
  }, [pluginId, slot, currentProps]);

  // Decide whether to mount based on the plugin's shouldShow (background-side).
  useEffect(() => {
    const active = getActivePlugin(pluginId);
    if (!active) { setShow(false); return; }
    const offer = active.slotOffers.find((o) => o.name === slot);
    if (!offer) { setShow(false); return; }
    if (!offer.hasShouldShow) { setShow(true); return; }
    let cancelled = false;
    active.background
      .evaluateShouldShow(slot, props)
      .then((s) => { if (!cancelled) setShow(s); })
      .catch(() => { if (!cancelled) setShow(false); });
    return () => { cancelled = true; };
  }, [pluginId, slot, props]);

  useEffect(() => {
    if (show === false) onShownChangeRef.current?.(false);
  }, [show]);

  // The latest props, for a frame that starts after they changed.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Spawn / tear down the slot iframe. The bridge is the plugin runtime's,
  // loaded with the plugin itself (stores/plugin-store.ts), so this import
  // only picks it up.
  useEffect(() => {
    if (show !== true) return;
    const active = getActivePlugin(pluginId);
    const hostContainer = wrapperRef.current;
    if (!active || !hostContainer) return;
    const locale = (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ ?? 'en';
    let live = true;
    let inst: SandboxInstance | null = null;
    void loadHostBridge().then(({ createSlotInstance }) => {
      if (!live) return;
      const created = createSlotInstance({
        plugin: active.plugin,
        slot,
        code: active.code,
        locale,
        tier: active.tier,
        extraProps: props,
        fill,
        hostContainer,
        onResize: (h, w) => {
          // Where the focus is, before the frame takes its new size: a frame
          // that took the focus while it showed nothing doesn't count as shown.
          focusRef.current?.observe();
          setHeight(h);
          if (w !== undefined) setWidth(w);
          onHeightChangeRef.current?.(Math.min(h, maxSlotHeight(slot)));
        },
        onFloatingDropdown: (msg) => {
          if (msg.type === 'floating-dropdown-open') {
            if (pendingOpenRef.current) clearTimeout(pendingOpenRef.current.timer);
            pendingOpenRef.current = null;
            // Refused: the frame hears that its list closed.
            const refuse = () => {
              instanceRef.current?.sendFloatingDropdownEvent({ type: 'floating-dropdown-dismiss', id: msg.id });
              setFloatingDropdown(null);
            };
            const decide = (late: boolean) => {
              pendingOpenRef.current = null;
              if (!live) return;
              // Not over a dialog, popover or menu the frame is not inside.
              if (hostLayerOutside(hostContainer)) return refuse();
              // Only while the user is in the frame.
              const focus = focusRef.current?.allows() ?? 'no';
              if (focus === 'away' && !late) {
                pendingOpenRef.current = { id: msg.id, timer: setTimeout(() => decide(true), FOCUS_ARRIVAL_MS) };
                return;
              }
              if (focus !== 'yes') return refuse();
              // No place that keeps clear of what the list must not cover.
              if (!placeForFrame(hostContainer, msg)) return refuse();
              setFloatingDropdown({
                id: msg.id,
                rect: msg.rect,
                options: msg.options,
                multiple: msg.multiple,
                selectedValues: msg.selectedValues,
                singleValue: msg.singleValue,
                highlightedIndex: msg.highlightedIndex,
                ariaLabel: msg.ariaLabel,
              });
            };
            decide(false);
          } else if (msg.type === 'floating-dropdown-update') {
            setFloatingDropdown((prev) => {
              if (!prev || prev.id !== msg.id) return prev;
              return {
                ...prev,
                ...(msg.rect ? { rect: msg.rect } : {}),
                ...(msg.options ? { options: msg.options } : {}),
                ...(msg.multiple !== undefined ? { multiple: msg.multiple } : {}),
                ...(msg.selectedValues ? { selectedValues: msg.selectedValues } : {}),
                ...(msg.singleValue !== undefined ? { singleValue: msg.singleValue } : {}),
                ...(msg.highlightedIndex !== undefined ? { highlightedIndex: msg.highlightedIndex } : {}),
              };
            });
          } else if (msg.type === 'floating-dropdown-close') {
            if (pendingOpenRef.current?.id === msg.id) {
              clearTimeout(pendingOpenRef.current.timer);
              pendingOpenRef.current = null;
            }
            setFloatingDropdown((prev) => (prev?.id === msg.id ? null : prev));
          }
        },
      });
      inst = created;
      instanceRef.current = created;
      if (propsRef.current !== props) created.updateProps(propsRef.current);
      // A frame that fails to start stays blank; say so to a caller that can
      // draw something in its place.
      if (onShownChangeRef.current) {
        created.initPromise.then(
          () => { if (live) onShownChangeRef.current?.(true); },
          () => { if (live) onShownChangeRef.current?.(false); },
        );
      }
    });
    return () => {
      live = false;
      if (pendingOpenRef.current) clearTimeout(pendingOpenRef.current.timer);
      pendingOpenRef.current = null;
      try { inst?.destroy(); } catch { /* ignore */ }
      instanceRef.current = null;
      setFloatingDropdown(null);
    };
    // We intentionally don't depend on props here - propagating prop
    // changes happens via postMessage below to avoid iframe churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, pluginId, slot, fill]);

  // Push prop updates without remount.
  useEffect(() => {
    instanceRef.current?.updateProps(props);
  }, [props]);

  // Follow the focus while the frame is up.
  useEffect(() => {
    if (show !== true) return;
    return focusRef.current?.start();
  }, [show]);

  // An open list closes when a dialog, popover or menu opens that the frame
  // is not inside, or when the frame stops showing: taken out of the page,
  // hidden by a style or class change, or left with no room by the layout.
  // When a part it must not cover appears or moves, it moves, or closes when
  // no place is left.
  const openDropdownId = floatingDropdown?.id ?? null;
  useEffect(() => {
    if (openDropdownId === null || typeof MutationObserver === 'undefined') return;
    let drawnAt = '';
    const closeIfGone = () => {
      focusRef.current?.observe();
      const frame = wrapperRef.current?.querySelector('iframe') ?? wrapperRef.current;
      const dropdown = dropdownStateRef.current;
      const place = frame && frameShows(frame) && !hostLayerOutside(wrapperRef.current) && dropdown?.id === openDropdownId
        ? placeForFrame(wrapperRef.current, dropdown)
        : null;
      if (place) {
        const at = JSON.stringify(place);
        if (drawnAt && at !== drawnAt) setPlacementTick((n) => n + 1);
        drawnAt = at;
        return;
      }
      instanceRef.current?.sendFloatingDropdownEvent({ type: 'floating-dropdown-dismiss', id: openDropdownId });
      setFloatingDropdown((prev) => (prev?.id === openDropdownId ? null : prev));
    };
    const observer = new MutationObserver(closeIfGone);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-modal', 'role', 'aria-expanded', 'aria-haspopup', 'inert', 'hidden', 'style', 'class', LIST_AVOID_ATTRIBUTE],
    });
    // The layout can take the frame's room with no change in those attributes.
    const timer = setInterval(closeIfGone, FRAME_CHECK_MS);
    closeIfGone();
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [openDropdownId]);

  // Re-theme the live slot iframe when the host theme changes (dark/light
  // toggle or custom theme switch), without tearing down the iframe. Reacting
  // to resolvedTheme + activeThemeId covers both; the snapshot reads the
  // resolved DOM values so it picks up whichever is active.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  useEffect(() => {
    instanceRef.current?.setTheme(snapshotHostTheme());
    // The store may apply the new theme to the page after this render: read
    // it again a frame later, so the frame never keeps the old values.
    const frame = requestAnimationFrame(() => instanceRef.current?.setTheme(snapshotHostTheme()));
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme, activeThemeId]);

  if (show !== true) return null;
  const wrapper = (
    <div
      ref={wrapperRef}
      style={inline
        ? { display: 'inline-block', verticalAlign: 'middle', height, width: width ?? 0, maxWidth: '100%', overflow: 'hidden' }
        // Never taller than the slot's limit, whatever the frame says.
        : fill ? { flex: '1 1 0%', minHeight: minFillHeight ?? 0 } : { height, minHeight: height, maxHeight: maxSlotHeight(slot), overflow: 'hidden' }}
      // A frame with nothing to show must not be a stop for Tab, where the
      // focus would vanish. Not visibility: hidden, because the browser stops
      // rendering an isolated frame then, and only its rendering reports a height.
      inert={!fill && height === 0}
      data-plugin-iframe-slot={`${pluginId}:${slot}`}
      data-plugin-iframe-fill={fill || undefined}
    />
  );
  return (
    <>
      {slot === 'app-top-banner' ? (
        // The top banner is on every page and looks like part of the app:
        // the host names its plugin beside it, with the way to turn it off,
        // also while the frame shows nothing.
        <div className="flex items-start" data-plugin-top-banner={pluginId}>
          <div className="min-w-0 flex-1">{wrapper}</div>
          <TopBannerControl pluginId={pluginId} />
        </div>
      ) : wrapper}
      {floatingDropdown && (
        <FloatingDropdownPortal
          dropdown={floatingDropdown}
          pluginName={getActivePlugin(pluginId)?.plugin.name || pluginId}
          wrapperEl={wrapperRef.current}
          onSelect={(option) => {
            instanceRef.current?.sendFloatingDropdownEvent({
              type: 'floating-dropdown-select',
              id: floatingDropdown.id,
              option,
            });
          }}
          onHighlight={(index) => {
            instanceRef.current?.sendFloatingDropdownEvent({
              type: 'floating-dropdown-highlight',
              id: floatingDropdown.id,
              index,
            });
          }}
          onDismiss={(reason) => {
            // Closed by the user with a click outside: not drawn again until
            // they have left the frame and come back.
            if (reason === 'outside') focusRef.current?.dismiss();
            instanceRef.current?.sendFloatingDropdownEvent({
              type: 'floating-dropdown-dismiss',
              id: floatingDropdown.id,
            });
            setFloatingDropdown(null);
          }}
          onPressStart={focusRef.current.hold}
          onPressEnd={focusRef.current.release}
        />
      )}
    </>
  );
}

function shallowEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

/**
 * Beside a plugin's top banner: the plugin's name, which its frame can't
 * cover or change, and a menu to turn the plugin off, headed by the name
 * (below 640 px the chip shows only its icon, so the menu says whose it is).
 * A plugin the administrator turned on for everyone can't be turned off
 * here, so it gets the name only, shown at every width.
 */
function TopBannerControl({ pluginId }: { pluginId: string }) {
  const t = useTranslations('plugins.dialog');
  const installed = usePluginStore((s) => s.plugins.find((p) => p.id === pluginId));
  const forcedByPolicy = usePolicyStore((s) => s.isPluginForceEnabled(pluginId));
  const disablePlugin = usePluginStore((s) => s.disablePlugin);
  const menu = useContextMenu<null>();
  const open = menu.contextMenu.isOpen;
  const name = installed?.name || getActivePlugin(pluginId)?.plugin.name || pluginId;
  const forced = installed?.forceEnabled === true || forcedByPolicy;
  const chipClass = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground';

  if (forced) {
    return (
      <span role="note" className={cn(chipClass, 'm-1 flex-shrink-0')} title={t('from_plugin', { name })} aria-label={t('from_plugin', { name })} data-plugin-banner-source="">
        <Puzzle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span className="max-w-[6rem] truncate sm:max-w-[10rem]">{name}</span>
      </span>
    );
  }
  const chip = (
    <>
      <Puzzle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
    </>
  );
  return (
    <div className="relative m-1 flex-shrink-0" data-plugin-banner-source="">
      <button
        type="button"
        onClick={(e) => (open ? menu.closeContextMenu() : menu.openContextMenuFrom(e.currentTarget, null, 'end'))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('plugin_menu', { name })}
        title={t('from_plugin', { name })}
        className={cn(chipClass, 'transition-colors duration-150 hover:bg-muted hover:text-foreground', open && 'bg-muted text-foreground')}
      >
        {chip}
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={open} position={menu.contextMenu.position} onClose={menu.closeContextMenu} label={t('plugin_menu', { name })}>
        <ContextMenuHeader>{t('from_plugin', { name })}</ContextMenuHeader>
        <ContextMenuItem
          icon={Power}
          label={t('turn_off', { name })}
          destructive
          onClick={() => { menu.closeContextMenu(); disablePlugin(pluginId); }}
        />
      </ContextMenu>
    </div>
  );
}

export interface Box { left: number; top: number; right: number; bottom: number }

export interface DropdownPlacement {
  left: number;
  width: number;
  /** One of top and bottom is set: the list opens downward from top or upward from bottom. */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export const DROPDOWN_MAX_HEIGHT = 240;
/** Room for the row naming the plugin and one option; with less the list doesn't open. */
export const DROPDOWN_MIN_HEIGHT = 64;
/** The list's border, padding and the row naming the plugin. */
const DROPDOWN_CHROME = 36;
/** One option row. */
const DROPDOWN_ROW = 32;
/** Between the anchor and the list. */
const DROPDOWN_GAP = 4;
/** Kept free between the list and the window's edge. */
const DROPDOWN_EDGE = 8;

/**
 * The height a frame's list needs at least: the row naming the plugin and two
 * options (one for a list of one). With less room it isn't drawn.
 */
export function minListHeight(options: number): number {
  return DROPDOWN_CHROME + Math.min(2, Math.max(1, options)) * DROPDOWN_ROW;
}

/**
 * Parts of the app a plugin's list never covers: the parts that tell the user
 * whose mail this is and what the app vouches for (the reader's subject,
 * sender, recipients and details, its own security and trust banners and
 * cards; the app's top bar and account switcher). Any element can opt in with
 * this one attribute.
 */
export const LIST_AVOID_ATTRIBUTE = 'data-plugin-list-avoid';

/**
 * What the list must not cover: the rows where the host names a plugin (a
 * dialog's header and its parts, a banner's name chip) and the parts marked
 * with LIST_AVOID_ATTRIBUTE.
 */
const LIST_AVOID_SELECTOR = `[data-plugin-dialog-header], [data-plugin-dialog-source], [data-plugin-dialog-menu], [data-plugin-banner-source], [${LIST_AVOID_ATTRIBUTE}]`;

function within(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function intersect(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

const CLIPPING = new Set(['hidden', 'clip', 'auto', 'scroll', 'overlay']);

/**
 * The part of the window an element shows in: its box cut by the window and
 * by every ancestor that clips it (a scrolling panel), up to a fixed one.
 */
function shownArea(el: Element): Box {
  let area = intersect(boxOf(el), { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (CLIPPING.has(style.overflowX) || CLIPPING.has(style.overflowY)) area = intersect(area, boxOf(p));
    if (style.position === 'fixed') break;
  }
  return area;
}

/**
 * Where the host draws a frame's list. `anchor` is in the frame's own
 * coordinates, `frame` is the frame's box in the window and `area` the part
 * of the window the frame shows in. The anchor is moved into that area, the
 * list is no wider than it and opens below or above the anchor, so it never
 * stands further from the frame than its own height. `limits.avoid` are boxes
 * the list must not cover (the host's rows naming a plugin, the parts of the
 * app marked as never covered), and `limits.top` the highest it may reach (a
 * frame in a plugin's dialog keeps its list below its own top edge, out of
 * the dialog's header). The list keeps clear of every avoided box: it opens
 * the other way, is shortened, or moves sideways within the area; it needs
 * `limits.minHeight` (default DROPDOWN_MIN_HEIGHT). Null when the frame shows
 * nowhere, or when no place leaves that much room.
 */
export function placeFloatingDropdown(
  anchor: FloatingDropdownRect,
  frame: Pick<Box, 'left' | 'top'>,
  area: Box,
  viewport: { width: number; height: number },
  limits: { avoid?: Box[]; top?: number; minHeight?: number } = {},
): DropdownPlacement | null {
  if (area.right - area.left <= 0 || area.bottom - area.top <= 0) return null;
  const anchorTop = within(frame.top + anchor.top, area.top, area.bottom);
  const anchorBottom = within(frame.top + anchor.bottom, anchorTop, area.bottom);
  const width = Math.min(anchor.width, area.right - area.left);
  if (!(width > 0)) return null;
  const avoid = (limits.avoid ?? []).filter((b) => b.right > b.left && b.bottom > b.top);
  const minHeight = limits.minHeight ?? DROPDOWN_MIN_HEIGHT;

  // In one column: open below or above the anchor, up to the window's edge,
  // `limits.top` or the first avoided box.
  const inColumn = (left: number): DropdownPlacement => {
    const right = left + width;
    const blocking = avoid.filter((b) => b.right > left && b.left < right);
    const downTop = anchorBottom + DROPDOWN_GAP;
    let downEnd = viewport.height - DROPDOWN_EDGE;
    for (const b of blocking) if (b.bottom > downTop) downEnd = Math.min(downEnd, b.top - DROPDOWN_GAP);
    const upBottom = anchorTop - DROPDOWN_GAP;
    let upStart = Math.max(DROPDOWN_EDGE, limits.top ?? DROPDOWN_EDGE);
    for (const b of blocking) if (b.top < upBottom) upStart = Math.max(upStart, b.bottom + DROPDOWN_GAP);
    const below = Math.min(DROPDOWN_MAX_HEIGHT, downEnd - downTop);
    const above = Math.min(DROPDOWN_MAX_HEIGHT, upBottom - upStart);
    const upward = below < 200 && above > below;
    const maxHeight = upward ? above : below;
    return upward
      ? { left, width, bottom: viewport.height - upBottom, maxHeight }
      : { left, width, top: downTop, maxHeight };
  };

  const wanted = within(frame.left + anchor.left, area.left, area.right - width);
  const first = inColumn(wanted);
  if (first.maxHeight >= minHeight) return first;
  // Moved sideways, just past an avoided box, still within the area: the
  // place with the most room, the nearest to where it was asked for.
  let best: DropdownPlacement | null = null;
  for (const b of avoid) {
    for (const candidate of [b.right + DROPDOWN_GAP, b.left - DROPDOWN_GAP - width]) {
      const left = within(candidate, area.left, area.right - width);
      if (left === wanted) continue;
      const place = inColumn(left);
      if (place.maxHeight < minHeight) continue;
      if (!best || place.maxHeight > best.maxHeight
        || (place.maxHeight === best.maxHeight && Math.abs(left - wanted) < Math.abs(best.left - wanted))) best = place;
    }
  }
  return best;
}

/**
 * Where a frame's list goes now, or null when it can't be drawn: the frame
 * isn't drawn or shows nowhere, or no place keeps clear of the parts the list
 * must not cover with room for two options.
 */
function placeForFrame(wrapperEl: HTMLElement | null, dropdown: Pick<FloatingDropdownState, 'rect' | 'options'>): DropdownPlacement | null {
  if (typeof window === 'undefined') return null;
  const iframe = wrapperEl?.querySelector('iframe') ?? wrapperEl;
  if (!iframe || !isDrawn(iframe)) return null;
  // In a plugin's dialog the list stays below the frame's top, out of the header.
  const layer = wrapperEl?.closest('[data-plugin-dialog-layer]') ?? null;
  // A modal plugin dialog lies over the page behind its backdrop: there only
  // its own header counts. A popover dialog has no backdrop, so the page's
  // marked parts around it count too.
  const behindBackdrop = !!layer && !layer.hasAttribute('data-plugin-dialog-popover');
  const area = shownArea(iframe);
  return placeFloatingDropdown(
    dropdown.rect,
    iframe.getBoundingClientRect(),
    area,
    { width: window.innerWidth, height: window.innerHeight },
    {
      avoid: [...document.querySelectorAll(LIST_AVOID_SELECTOR)].filter((el) => !behindBackdrop || !!layer?.contains(el)).map(boxOf),
      minHeight: minListHeight(dropdown.options.length),
      ...(layer ? { top: area.top } : {}),
    },
  );
}

/** Whether the element is drawn: not hidden by its own style or an ancestor's. */
function isDrawn(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.display === 'none') return false;
    if (n === el && style.visibility === 'hidden') return false;
  }
  return true;
}

function FloatingDropdownPortal({
  dropdown,
  pluginName,
  wrapperEl,
  onSelect,
  onHighlight,
  onDismiss,
  onPressStart,
  onPressEnd,
}: {
  dropdown: FloatingDropdownState;
  pluginName: string;
  wrapperEl: HTMLElement | null;
  onSelect: (option: FloatingDropdownOption) => void;
  onHighlight: (index: number) => void;
  onDismiss: (reason: 'outside' | 'scroll' | 'resize') => void;
  /** A press in the list starts and ends: the pick reaches the frame before the focus is read again. */
  onPressStart: () => void;
  onPressEnd: () => void;
}) {
  const t = useTranslations('plugin_surfaces');
  const tSource = useTranslations('plugins.dialog');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // In window coordinates, inside the part of the window the frame shows in,
  // only for a frame that is drawn, and never over a row naming a plugin or a
  // part of the app marked as never covered.
  const place = placeForFrame(wrapperEl, dropdown);

  // Auto-scroll highlighted option into view
  useEffect(() => {
    const i = dropdown.highlightedIndex;
    if (i >= 0 && optionRefs.current[i]) {
      optionRefs.current[i]?.scrollIntoView({ block: 'nearest' });
    }
  }, [dropdown.highlightedIndex]);

  // Outside click and scroll handling
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onDismiss('outside');
      }
    };
    const onScroll = (e: Event) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) {
        return; // Allow scroll inside the dropdown listbox itself
      }
      onDismiss('scroll');
    };
    const onResize = () => onDismiss('resize');

    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onDismiss]);

  if (typeof document === 'undefined' || !place) return null;
  // A frame in a plugin dialog gets its list in that dialog's outer element
  // (plugin-dialog-host.tsx), so a dialog drawn above that one is above the
  // list too.
  const layer = wrapperEl?.closest<HTMLElement>('[data-plugin-dialog-layer]') ?? document.body;
  const label = dropdown.ariaLabel?.trim();

  return createPortal(
    <div
      ref={dropdownRef}
      id={`plugin-dropdown-${dropdown.id}`}
      role="listbox"
      aria-multiselectable={dropdown.multiple || undefined}
      aria-label={label ? t('dropdown_list_labelled', { label, name: pluginName }) : t('dropdown_list', { name: pluginName })}
      style={{
        position: 'fixed',
        left: `${place.left}px`,
        top: place.top !== undefined ? `${place.top}px` : undefined,
        bottom: place.bottom !== undefined ? `${place.bottom}px` : undefined,
        width: `${place.width}px`,
        maxHeight: `${place.maxHeight}px`,
        // Under the toasts (z-index 99999), so a toast's line naming its plugin stays readable.
        zIndex: 99990,
      }}
      className="overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 focus:outline-none animate-in fade-in-50 zoom-in-95 duration-100"
      onPointerDown={onPressStart}
      onMouseDown={onPressStart}
      onClick={onPressEnd}
    >
      {/* Whose list it is, in a row the options scroll under and the plugin's text can't change. */}
      <div
        aria-hidden="true"
        data-plugin-dropdown-source=""
        className="sticky -top-1 z-[1] -mx-1 -mt-1 mb-1 flex items-center gap-1 border-b border-border bg-popover px-3 py-1 text-[0.6875rem] text-muted-foreground"
      >
        <Puzzle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{tSource('from_plugin', { name: pluginName })}</span>
      </div>
      {dropdown.options.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground text-center">
          No results
        </div>
      ) : (
        dropdown.options.map((opt, i) => {
          const isSelected = dropdown.multiple
            ? dropdown.selectedValues.includes(opt.value)
            : opt.value === dropdown.singleValue;
          const isHighlighted = dropdown.highlightedIndex === i;
          return (
            <div
              key={opt.value}
              ref={(el) => { optionRefs.current[i] = el; }}
              id={`plugin-dropdown-${dropdown.id}-opt-${i}`}
              role="option"
              aria-selected={isSelected}
              aria-disabled={opt.disabled}
              onMouseDown={(e) => {
                // Prevent stealing focus from the input in the iframe
                e.preventDefault();
              }}
              onClick={() => {
                if (opt.disabled) return;
                onSelect(opt);
              }}
              onMouseEnter={() => {
                onHighlight(i);
              }}
              className={cn(
                // scroll-mt: an option scrolled to with the keys stays clear of the name row.
                'relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors scroll-mt-7',
                isHighlighted ? 'bg-accent text-accent-foreground' : 'text-foreground',
                isSelected && 'font-medium',
                opt.disabled && 'pointer-events-none opacity-50',
              )}
            >
              <span className="truncate">{opt.label}</span>
              {isSelected && <Check className="w-4 h-4 ms-2 shrink-0 text-primary" aria-hidden="true" />}
            </div>
          );
        })
      )}
    </div>,
    layer,
  );
}
