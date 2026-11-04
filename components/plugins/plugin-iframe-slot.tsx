'use client';

// Sandboxed slot mount. One iframe per (plugin, slot) - created lazily after
// the background instance confirms `shouldShow(context)` (if defined). The
// iframe renders the plugin's slot component using the plugin's bundle in a
// null-origin context; its height is pushed back via postMessage and applied
// to a wrapper <div>.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SlotName } from '@/lib/plugin-types';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { createSlotInstance, type SandboxInstance } from '@/lib/plugin-sandbox/host-bridge';
import type { FloatingDropdownOption } from '@/lib/plugin-sandbox/protocol';
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
  rect: { left: number; top: number; bottom: number; width: number; height: number };
  options: FloatingDropdownOption[];
  multiple?: boolean;
  selectedValues: string[];
  singleValue?: string;
  highlightedIndex: number;
  ariaLabel?: string;
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

  // Spawn / tear down the slot iframe.
  useEffect(() => {
    if (show !== true) return;
    const active = getActivePlugin(pluginId);
    if (!active || !wrapperRef.current) return;
    const locale = (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ ?? 'en';
    const inst = createSlotInstance({
      plugin: active.plugin,
      slot,
      code: active.code,
      locale,
      tier: active.tier,
      extraProps: props,
      fill,
      hostContainer: wrapperRef.current,
      onResize: (h, w) => {
        setHeight(h);
        if (w !== undefined) setWidth(w);
      },
      onFloatingDropdown: (msg) => {
        if (msg.type === 'floating-dropdown-open') {
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
    instanceRef.current = inst;
    // A frame that fails to start stays blank; say so to a caller that can
    // draw something in its place.
    let live = true;
    if (onShownChangeRef.current) {
      inst.initPromise.then(
        () => { if (live) onShownChangeRef.current?.(true); },
        () => { if (live) onShownChangeRef.current?.(false); },
      );
    }
    return () => {
      live = false;
      try { inst.destroy(); } catch { /* ignore */ }
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

function FloatingDropdownPortal({
  dropdown,
  wrapperEl,
  onSelect,
  onHighlight,
  onDismiss,
}: {
  dropdown: FloatingDropdownState;
  wrapperEl: HTMLElement | null;
  onSelect: (option: FloatingDropdownOption) => void;
  onHighlight: (index: number) => void;
  onDismiss: () => void;
}) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Compute screen coordinates relative to host viewport
  const iframe = wrapperEl?.querySelector('iframe') ?? wrapperEl;
  const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
  const hostLeft = iframeRect.left + dropdown.rect.left;
  const hostTop = iframeRect.top + dropdown.rect.top;
  const hostBottom = iframeRect.top + dropdown.rect.bottom;
  const hostWidth = dropdown.rect.width;

  const spaceBelow = typeof window !== 'undefined' ? window.innerHeight - hostBottom - 8 : 300;
  const spaceAbove = hostTop - 8;
  const openUpward = spaceBelow < 200 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(240, openUpward ? spaceAbove : spaceBelow));
  const left = typeof window !== 'undefined' ? Math.max(8, Math.min(hostLeft, window.innerWidth - hostWidth - 8)) : hostLeft;
  const top = openUpward ? undefined : hostBottom + 4;
  const bottom = openUpward && typeof window !== 'undefined' ? window.innerHeight - hostTop + 4 : undefined;

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

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dropdownRef}
      id={`plugin-dropdown-${dropdown.id}`}
      role="listbox"
      aria-multiselectable={dropdown.multiple || undefined}
      aria-label={dropdown.ariaLabel}
      style={{
        position: 'fixed',
        left: `${left}px`,
        top: top !== undefined ? `${top}px` : undefined,
        bottom: bottom !== undefined ? `${bottom}px` : undefined,
        width: `${hostWidth}px`,
        maxHeight: `${maxHeight}px`,
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
    document.body,
  );
}
