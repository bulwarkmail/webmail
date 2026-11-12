'use client';

// Sandboxed slot mount. One iframe per (plugin, slot) - created lazily after
// the background instance confirms `shouldShow(context)` (if defined). The
// iframe renders the plugin's slot component using the plugin's bundle in a
// null-origin context; its height is pushed back via postMessage and applied
// to a wrapper <div>.
//
// A frame may ask the host to draw a dropdown list for it (the UI kit's
// Select). The host draws it in its own document, so it keeps to the frame:
// it stands in the part of the window the frame takes up, plus its own
// height; it is drawn in the layer of the plugin dialog the frame is in; and
// while a dialog is open that the frame is not inside (a question the host
// asks about the plugin, an app dialog, a plugin's prompt on top of its own
// dialog), the host draws no list for the frame and closes an open one.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { SlotName } from '@/lib/plugin-types';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import type { SandboxInstance } from '@/lib/plugin-sandbox/host-bridge';
import { loadHostBridge } from '@/lib/plugin-sandbox/load-host-bridge';
import type { FloatingDropdownOption, FloatingDropdownRect } from '@/lib/plugin-sandbox/protocol';
import { slotPropsFor } from '@/lib/plugin-sandbox/permissions';
import { isInlineSlot } from '@/lib/plugin-sandbox/slot-layout';
import { snapshotHostTheme } from '@/lib/plugin-sandbox/host-theme';
import { useThemeStore } from '@/stores/theme-store';
import { Check } from '@/components/icons';
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
  return (
    <>
      <div
        ref={wrapperRef}
        style={inline
          ? { display: 'inline-block', verticalAlign: 'middle', height, width: width ?? 0, maxWidth: '100%', overflow: 'hidden' }
          : fill ? { flex: '1 1 0%', minHeight: minFillHeight ?? 0 } : { height, minHeight: height }}
        // A frame with nothing to show must not be a stop for Tab, where the
        // focus would vanish. Not visibility: hidden, because the browser stops
        // rendering an isolated frame then, and only its rendering reports a height.
        inert={!fill && height === 0}
        data-plugin-iframe-slot={`${pluginId}:${slot}`}
        data-plugin-iframe-fill={fill || undefined}
      />
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
const DROPDOWN_MIN_HEIGHT = 120;
/** Between the anchor and the list. */
const DROPDOWN_GAP = 4;
/** Kept free between the list and the window's edge. */
const DROPDOWN_EDGE = 8;

function within(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function intersect(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

/**
 * The part of the window an element shows in: its box cut by the window and
 * by every ancestor that clips it (a scrolling panel), up to a fixed one.
 */
function shownArea(el: Element): Box {
  const r = el.getBoundingClientRect();
  let area = intersect(
    { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  );
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const c = p.getBoundingClientRect();
      area = intersect(area, { left: c.left, top: c.top, right: c.right, bottom: c.bottom });
    }
    if (style.position === 'fixed') break;
  }
  return area;
}

/**
 * Where the host draws a frame's list. `anchor` is in the frame's own
 * coordinates, `frame` is the frame's box in the window and `area` the part
 * of the window the frame shows in. The anchor is moved into that area, the
 * list is no wider than it and opens below or above the anchor, so it never
 * stands further from the frame than its own height. Null when the frame
 * shows nowhere.
 */
export function placeFloatingDropdown(
  anchor: FloatingDropdownRect,
  frame: Pick<Box, 'left' | 'top'>,
  area: Box,
  viewport: { width: number; height: number },
): DropdownPlacement | null {
  if (area.right < area.left || area.bottom < area.top) return null;
  const anchorTop = within(frame.top + anchor.top, area.top, area.bottom);
  const anchorBottom = within(frame.top + anchor.bottom, anchorTop, area.bottom);
  const width = Math.max(0, Math.min(anchor.width, area.right - area.left));
  const left = within(frame.left + anchor.left, area.left, area.right - width);
  const spaceBelow = viewport.height - anchorBottom - DROPDOWN_EDGE;
  const spaceAbove = anchorTop - DROPDOWN_EDGE;
  const upward = spaceBelow < 200 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(DROPDOWN_MIN_HEIGHT, Math.min(DROPDOWN_MAX_HEIGHT, upward ? spaceAbove : spaceBelow));
  return upward
    ? { left, width, bottom: viewport.height - anchorTop + DROPDOWN_GAP, maxHeight }
    : { left, width, top: anchorBottom + DROPDOWN_GAP, maxHeight };
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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // In window coordinates, inside the part of the window the frame shows in.
  const iframe = wrapperEl?.querySelector('iframe') ?? wrapperEl;
  const place = iframe && typeof window !== 'undefined'
    ? placeFloatingDropdown(dropdown.rect, iframe.getBoundingClientRect(), shownArea(iframe), { width: window.innerWidth, height: window.innerHeight })
    : null;

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
        zIndex: 100010,
      }}
      className="overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 focus:outline-none animate-in fade-in-50 zoom-in-95 duration-100"
    >
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
                'relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors',
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
