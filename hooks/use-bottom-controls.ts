'use client';

import { useEffect, useState } from 'react';

/**
 * Bars pinned to the bottom of the screen register here: on a phone the tab
 * bar and a viewer's action bar, on any screen an editor's Save/Cancel
 * footer. While any is on screen,
 * `--bottom-controls-height` on <html> says how far from the bottom of the
 * window the topmost of them reaches, and toasts sit above it.
 */
const bars = new Set<HTMLElement>();
let frame = 0;

function update() {
  frame = 0;
  if (typeof document === 'undefined') return;
  let height = 0;
  for (const bar of bars) {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    height = Math.max(height, window.innerHeight - rect.top);
  }
  const root = document.documentElement.style;
  if (bars.size === 0) root.removeProperty('--bottom-controls-height');
  else root.setProperty('--bottom-controls-height', `${Math.max(0, Math.round(height))}px`);
}

function schedule() {
  if (frame) return;
  if (typeof requestAnimationFrame === 'undefined') update();
  else frame = requestAnimationFrame(update);
}

/**
 * Measure a bottom bar into `--bottom-controls-height` while it is mounted
 * and `active`. Returns the ref to put on the bar:
 *
 *   const barRef = useBottomControls(isMobile);
 *   <nav ref={barRef} className="fixed bottom-0 ...">
 */
export function useBottomControls(active = true): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el || !active) return;
    bars.add(el);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    window.addEventListener('resize', schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      bars.delete(el);
      update();
    };
  }, [el, active]);
  return setEl;
}
