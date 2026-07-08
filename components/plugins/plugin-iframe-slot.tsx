'use client';

// Sandboxed slot mount. One iframe per (plugin, slot) - created lazily after
// the background instance confirms `shouldShow(context)` (if defined). The
// iframe renders the plugin's slot component using the plugin's bundle in a
// null-origin context; its height is pushed back via postMessage and applied
// to a wrapper <div>.

import React, { useEffect, useRef, useState } from 'react';
import type { SlotName } from '@/lib/plugin-types';
import { get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { createSlotInstance, type SandboxInstance } from '@/lib/plugin-sandbox/host-bridge';
import { snapshotHostTheme } from '@/lib/plugin-sandbox/host-theme';
import { useThemeStore } from '@/stores/theme-store';

interface Props {
  pluginId: string;
  slot: SlotName;
  extraProps?: Record<string, unknown>;
}

export function PluginIframeSlot({ pluginId, slot, extraProps }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<SandboxInstance | null>(null);
  const [height, setHeight] = useState<number>(0);
  // null = pending, true/false = decided
  const [show, setShow] = useState<boolean | null>(null);

  // Decide whether to mount based on the plugin's shouldShow (background-side).
  useEffect(() => {
    const active = getActivePlugin(pluginId);
    if (!active) { setShow(false); return; }
    const offer = active.slotOffers.find((o) => o.name === slot);
    if (!offer) { setShow(false); return; }
    if (!offer.hasShouldShow) { setShow(true); return; }
    let cancelled = false;
    active.background
      .evaluateShouldShow(slot, extraProps ?? {})
      .then((s) => { if (!cancelled) setShow(s); })
      .catch(() => { if (!cancelled) setShow(false); });
    return () => { cancelled = true; };
  }, [pluginId, slot, extraProps]);

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
      extraProps: extraProps ?? {},
      hostContainer: wrapperRef.current,
      onResize: (h) => setHeight(h),
    });
    instanceRef.current = inst;
    return () => {
      try { inst.destroy(); } catch { /* ignore */ }
      instanceRef.current = null;
    };
    // We intentionally don't depend on extraProps here - propagating prop
    // changes happens via postMessage below to avoid iframe churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, pluginId, slot]);

  // Push prop updates without remount.
  useEffect(() => {
    instanceRef.current?.updateProps(extraProps ?? {});
  }, [extraProps]);

  // Re-theme the live slot iframe when the host theme changes (dark/light
  // toggle or custom theme switch), without tearing down the iframe. Reacting
  // to resolvedTheme + activeThemeId covers both; the snapshot reads the
  // resolved DOM values so it picks up whichever is active.
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  useEffect(() => {
    instanceRef.current?.setTheme(snapshotHostTheme());
  }, [resolvedTheme, activeThemeId]);

  if (show !== true) return null;
  return <div ref={wrapperRef} style={{ height, minHeight: height }} data-plugin-iframe-slot={`${pluginId}:${slot}`} />;
}
