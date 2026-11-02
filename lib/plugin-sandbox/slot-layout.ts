// How slot iframes are sized. Shared by the host (which sizes the iframe)
// and the sandbox runtime (which measures the plugin's content).

import { SLOT_CATALOG, type SlotSpec } from '../plugin-slot-catalog';
import type { SlotName } from '../plugin-types';

/**
 * Slots that sit in a row next to host controls (toolbars, attachment chips,
 * the event form's action row). Their iframe takes the plugin content's own
 * width; everything else fills the width of its container.
 */
export const INLINE_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>(
  (Object.entries(SLOT_CATALOG) as [SlotName, SlotSpec][])
    .filter(([, spec]) => spec.kind === 'frame' && spec.inline)
    .map(([name]) => name),
);

export function isInlineSlot(slot: SlotName | string | null | undefined): boolean {
  return !!slot && INLINE_SLOTS.has(slot as SlotName);
}

/** Tallest a slot iframe gets; content past this scrolls inside it. */
export const MAX_SLOT_HEIGHT = 2000;
/** Widest an inline slot gets, so one plugin can't push the host's buttons off screen. */
export const MAX_INLINE_SLOT_WIDTH = 480;

function clamp(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, Math.ceil(value)));
}

/** A reported height the host can use, or null for garbage (NaN, strings). */
export function clampSlotHeight(height: unknown): number | null {
  return clamp(height, MAX_SLOT_HEIGHT);
}

export function clampSlotWidth(width: unknown): number | null {
  return clamp(width, MAX_INLINE_SLOT_WIDTH);
}

/**
 * Panel slots whose frame may fill the panel (`slots[name].fill = true`):
 * the plugin's root is then as tall as the panel and scrolls inside, so it
 * can pin controls at the bottom, like a chat input. Elsewhere a frame grows
 * with its content.
 */
export const FILLABLE_SLOTS: readonly string[] = ['composer-sidebar', 'composer-sidebar-right', 'email-detail-sidebar', 'app-side-panel', 'app-page'];

export function isFillableSlot(slot: string): boolean {
  return FILLABLE_SLOTS.includes(slot);
}
