'use client';

// Sandboxed slot mount. One iframe per (plugin, slot) - created lazily after
// the background instance confirms `shouldShow(context)` (if defined). The
// iframe renders the plugin's slot component using the plugin's bundle in a
// null-origin context; its height is pushed back via postMessage and applied
// to a wrapper <div>.
//
// A frame may ask the host to draw a dropdown list for it (the UI kit's
// Combobox). The host draws it in its own document, so it keeps to the frame:
// only a frame that is drawn with a real size gets one; it stands in the part
// of the window the frame takes up, plus its own height; it never covers a
// row where the host names a plugin (a dialog's header, a banner's name chip),
// and in a plugin's dialog it stays below the frame's top; its first row
// names the plugin; it is drawn in the layer of the plugin dialog the frame
// is in; and while a dialog is open that the frame is not inside (a question
// the host asks about the plugin, an app dialog, a plugin's prompt on top of
// its own dialog), the host draws no list for the frame and closes an open
// one. Outside modals it may lie over the app next to the frame, within its
// 240 px: it closes on any click outside it, on scrolling and on resizing.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { SlotName } from '@/lib/plugin-types';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import type { SandboxInstance } from '@/lib/plugin-sandbox/host-bridge';
import { loadHostBridge } from '@/lib/plugin-sandbox/load-host-bridge';
import type { FloatingDropdownOption, FloatingDropdownRect } from '@/lib/plugin-sandbox/protocol';
import { slotPropsFor } from '@/lib/plugin-sandbox/permissions';
import { isInlineSlot, maxSlotHeight } from '@/lib/plugin-sandbox/slot-layout';
import { snapshotHostTheme } from '@/lib/plugin-sandbox/host-theme';
import { useThemeStore } from '@/stores/theme-store';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { Check, Power, Puzzle } from '@/components/icons';
import { cn } from '@/lib/utils';

interface Props {
  pluginId: string;
  slot: SlotName;
  extraProps?: Record<string, unknown>;
  /** The frame fills its panel and scrolls inside, instead of growing with its content. */
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

/** The host's open dialogs, the app's own and the plugins' alike. */
const OPEN_DIALOG_SELECTOR = '[aria-modal="true"], [role="alertdialog"]';

/**
 * Whether a dialog is open that `el` is not inside. A list drawn for a
 * frame in `el` would then lie over that dialog, which may be the host
 * asking about this very plugin.
 */
export function dialogOutside(el: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  if (!el) return true;
  for (const dialog of document.querySelectorAll(OPEN_DIALOG_SELECTOR)) {
    if (!dialog.contains(el)) return true;
  }
  return false;
}

export function PluginIframeSlot({ pluginId, slot, extraProps, fill = false, minFillHeight, onShownChange }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<SandboxInstance | null>(null);
  const onShownChangeRef = useRef(onShownChange);
  useEffect(() => { onShownChangeRef.current = onShownChange; }, [onShownChange]);
  const [height, setHeight] = useState<number>(0);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const [floatingDropdown, setFloatingDropdown] = useState<FloatingDropdownState | null>(null);
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
          setHeight(h);
          if (w !== undefined) setWidth(w);
        },
        onFloatingDropdown: (msg) => {
          if (msg.type === 'floating-dropdown-open') {
            // Not over a dialog the frame is not inside: the frame hears that
            // its list closed.
            if (dialogOutside(hostContainer)) {
              instanceRef.current?.sendFloatingDropdownEvent({ type: 'floating-dropdown-dismiss', id: msg.id });
              setFloatingDropdown(null);
              return;
            }
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

  // An open list closes when a dialog opens that the frame is not inside.
  const openDropdownId = floatingDropdown?.id ?? null;
  useEffect(() => {
    if (openDropdownId === null || typeof MutationObserver === 'undefined') return;
    const closeIfCovered = () => {
      if (!dialogOutside(wrapperRef.current)) return;
      instanceRef.current?.sendFloatingDropdownEvent({ type: 'floating-dropdown-dismiss', id: openDropdownId });
      setFloatingDropdown((prev) => (prev?.id === openDropdownId ? null : prev));
    };
    const observer = new MutationObserver(closeIfCovered);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'role'] });
    closeIfCovered();
    return () => observer.disconnect();
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
        // the host names its plugin beside it, with the way to turn it off.
        <div className="flex items-start" data-plugin-top-banner={pluginId}>
          <div className="min-w-0 flex-1">{wrapper}</div>
          {height > 0 && <TopBannerControl pluginId={pluginId} />}
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
          onDismiss={() => {
            instanceRef.current?.sendFloatingDropdownEvent({
              type: 'floating-dropdown-dismiss',
              id: floatingDropdown.id,
            });
            setFloatingDropdown(null);
          }}
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
 * cover or change, and a menu to turn the plugin off. A plugin the
 * administrator turned on for everyone can't be turned off here, so it gets
 * the name only.
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
  const chip = (
    <>
      <Puzzle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
    </>
  );
  const chipClass = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground';

  if (forced) {
    return (
      <span role="note" className={cn(chipClass, 'm-1 flex-shrink-0')} title={t('from_plugin', { name })} aria-label={t('from_plugin', { name })} data-plugin-banner-source="">
        {chip}
      </span>
    );
  }
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
/** Between the anchor and the list. */
const DROPDOWN_GAP = 4;
/** Kept free between the list and the window's edge. */
const DROPDOWN_EDGE = 8;

/** The rows where the host names a plugin: a dialog's header and its parts, a banner's name chip. */
const PLUGIN_SOURCE_SELECTOR = '[data-plugin-dialog-header], [data-plugin-dialog-source], [data-plugin-dialog-menu], [data-plugin-banner-source]';

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
 * the list must not cover (the host's rows naming a plugin), and
 * `limits.top` the highest it may reach (a frame in a plugin's dialog keeps
 * its list below its own top edge, out of the dialog's header). Null when the
 * frame shows nowhere, or when neither direction leaves room for the list.
 */
export function placeFloatingDropdown(
  anchor: FloatingDropdownRect,
  frame: Pick<Box, 'left' | 'top'>,
  area: Box,
  viewport: { width: number; height: number },
  limits: { avoid?: Box[]; top?: number } = {},
): DropdownPlacement | null {
  if (area.right - area.left <= 0 || area.bottom - area.top <= 0) return null;
  const anchorTop = within(frame.top + anchor.top, area.top, area.bottom);
  const anchorBottom = within(frame.top + anchor.bottom, anchorTop, area.bottom);
  const width = Math.min(anchor.width, area.right - area.left);
  if (!(width > 0)) return null;
  const left = within(frame.left + anchor.left, area.left, area.right - width);
  const right = left + width;
  const blocking = (limits.avoid ?? []).filter((b) => b.right > b.left && b.bottom > b.top && b.right > left && b.left < right);

  // Downward: from under the anchor to the window's edge or the first blocking row.
  const downTop = anchorBottom + DROPDOWN_GAP;
  let downEnd = viewport.height - DROPDOWN_EDGE;
  for (const b of blocking) if (b.bottom > downTop) downEnd = Math.min(downEnd, b.top - DROPDOWN_GAP);
  // Upward: from above the anchor to the window's edge, `limits.top` or the first blocking row.
  const upBottom = anchorTop - DROPDOWN_GAP;
  let upStart = Math.max(DROPDOWN_EDGE, limits.top ?? DROPDOWN_EDGE);
  for (const b of blocking) if (b.top < upBottom) upStart = Math.max(upStart, b.bottom + DROPDOWN_GAP);

  const below = Math.min(DROPDOWN_MAX_HEIGHT, downEnd - downTop);
  const above = Math.min(DROPDOWN_MAX_HEIGHT, upBottom - upStart);
  const upward = below < 200 && above > below;
  const maxHeight = upward ? above : below;
  if (maxHeight < DROPDOWN_MIN_HEIGHT) return null;
  return upward
    ? { left, width, bottom: viewport.height - upBottom, maxHeight }
    : { left, width, top: downTop, maxHeight };
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
}: {
  dropdown: FloatingDropdownState;
  pluginName: string;
  wrapperEl: HTMLElement | null;
  onSelect: (option: FloatingDropdownOption) => void;
  onHighlight: (index: number) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('plugin_surfaces');
  const tSource = useTranslations('plugins.dialog');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // In window coordinates, inside the part of the window the frame shows in,
  // only for a frame that is drawn, and never over a row naming a plugin. In
  // a plugin's dialog the list stays below the frame's top, out of the header.
  const iframe = wrapperEl?.querySelector('iframe') ?? wrapperEl;
  const inDialog = !!wrapperEl?.closest('[data-plugin-dialog-layer]');
  let place: DropdownPlacement | null = null;
  if (iframe && typeof window !== 'undefined' && isDrawn(iframe)) {
    const area = shownArea(iframe);
    place = placeFloatingDropdown(
      dropdown.rect,
      iframe.getBoundingClientRect(),
      area,
      { width: window.innerWidth, height: window.innerHeight },
      { avoid: [...document.querySelectorAll(PLUGIN_SOURCE_SELECTOR)].map(boxOf), ...(inDialog ? { top: area.top } : {}) },
    );
  }

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
        onDismiss();
      }
    };
    const onScroll = (e: Event) => {
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) {
        return; // Allow scroll inside the dropdown listbox itself
      }
      onDismiss();
    };
    const onResize = () => onDismiss();

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
