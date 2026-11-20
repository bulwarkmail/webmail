// Notices a plugin shows (api.ui.showNotice): one of its own frames in the
// toasts' stack at the bottom end corner, for something the user should see
// while they go on working, such as an incoming call. Unlike a dialog it has
// no backdrop and never takes the focus; unlike a toast it holds the plugin's
// own UI and stays until the plugin or the user closes it.
// PluginNoticeHost (components/plugins/plugin-notice-host.tsx) draws them.

import type { InstalledPlugin } from '../plugin-types';
import { get as getActivePlugin } from './registry';
import { MAX_NOTICE_HEIGHT } from './slot-layout';

export interface NoticeRequest {
  id: string;
  pluginId: string;
  /** The plugin's own frame slot drawn in the notice; `plugin-notice` unless it names another. */
  slot: string;
  extraProps: Record<string, unknown>;
  /** Read out when the notice appears; not shown. */
  title: string;
  /** The frame's height in px; without it the frame takes its content's height. */
  height?: number;
}

/** How many notices of one plugin are up at once; one more closes the oldest. */
export const MAX_NOTICES_PER_PLUGIN = 3;
/** How many notices one plugin may show per minute. */
export const MAX_NOTICES_PER_MINUTE = 20;
export const MAX_NOTICE_TITLE = 200;
/** The least height a notice may ask for, in px; the most is the slot's (slot-layout.ts). */
export const MIN_NOTICE_HEIGHT = 40;

let shown: readonly NoticeRequest[] = [];
const listeners = new Set<() => void>();
const recentByPlugin = new Map<string, number[]>();
const lifetimes = new Map<string, { signal: AbortSignal; release: () => void }>();

function changed(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function remove(ids: ReadonlySet<string>): void {
  if (!shown.some((n) => ids.has(n.id))) return;
  for (const id of ids) {
    const life = lifetimes.get(id);
    if (!life) continue;
    life.signal.removeEventListener('abort', life.release);
    lifetimes.delete(id);
  }
  shown = shown.filter((n) => !ids.has(n.id));
  changed();
}

/**
 * Show a notice for `plugin`; returns its id. It belongs to the frame that
 * asked (`signal`): it closes when that frame goes, so a notice shown from
 * the background stays until the plugin is turned off. Throws with a
 * message the plugin sees.
 */
export function showNotice(plugin: Pick<InstalledPlugin, 'id'>, value: unknown, signal?: AbortSignal): string {
  if (!signal || signal.aborted) throw new Error('ui.showNotice requires a live sandbox instance');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ui.showNotice: expects { slot, extraProps, title, height }');
  const opts = value as Record<string, unknown>;
  const slot = opts.slot ?? 'plugin-notice';
  if (typeof slot !== 'string' || !slot) throw new Error('ui.showNotice: slot must be a slot name');
  if (!getActivePlugin(plugin.id)?.slotOffers.some((offer) => offer.name === slot)) {
    throw new Error(`ui.showNotice: the plugin offers no slot "${slot}"`);
  }
  const extraProps = opts.extraProps === undefined || opts.extraProps === null ? {} : opts.extraProps;
  if (typeof extraProps !== 'object' || Array.isArray(extraProps)) throw new Error('ui.showNotice: extraProps must be an object');
  if (opts.title !== undefined && typeof opts.title !== 'string') throw new Error('ui.showNotice: title must be a string');
  // eslint-disable-next-line no-control-regex -- one line of text
  const title = (opts.title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NOTICE_TITLE);
  let height: number | undefined;
  if (opts.height !== undefined && opts.height !== null) {
    if (typeof opts.height !== 'number' || !Number.isFinite(opts.height)) throw new Error('ui.showNotice: height must be a number');
    height = Math.min(MAX_NOTICE_HEIGHT, Math.max(MIN_NOTICE_HEIGHT, Math.round(opts.height)));
  }

  const now = Date.now();
  const recent = (recentByPlugin.get(plugin.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_NOTICES_PER_MINUTE) throw new Error('This plugin showed too many notices; try again in a minute');
  recent.push(now);
  recentByPlugin.set(plugin.id, recent);

  // The oldest make way, so a plugin never has more than a few up.
  const own = shown.filter((n) => n.pluginId === plugin.id);
  const oldest = own.slice(0, Math.max(0, own.length - MAX_NOTICES_PER_PLUGIN + 1)).map((n) => n.id);
  if (oldest.length > 0) remove(new Set(oldest));

  const notice: NoticeRequest = {
    id: uid(),
    pluginId: plugin.id,
    slot,
    extraProps: extraProps as Record<string, unknown>,
    title,
    ...(height !== undefined ? { height } : {}),
  };
  const release = () => remove(new Set([notice.id]));
  lifetimes.set(notice.id, { signal, release });
  signal.addEventListener('abort', release, { once: true });
  shown = [...shown, notice];
  changed();
  return notice.id;
}

/** The plugin closes one of its notices, from any of its frames. Closing one that is gone does nothing. */
export function closeNotice(pluginId: string, id: unknown): void {
  if (typeof id !== 'string') throw new Error('ui.closeNotice requires a notice id');
  if (shown.some((n) => n.id === id && n.pluginId === pluginId)) remove(new Set([id]));
}

/** The user closed a notice (its ✕). */
export function dismissNotice(id: string): void {
  remove(new Set([id]));
}

/** Close every notice of a plugin (called on unload). */
export function closeNoticesFor(pluginId: string): void {
  remove(new Set(shown.filter((n) => n.pluginId === pluginId).map((n) => n.id)));
}

/** The notices up now, oldest first; a new array after each change, the same one between. */
export function notices(): readonly NoticeRequest[] {
  return shown;
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget every notice and the rate limit (tests). */
export function resetNotices(): void {
  for (const life of lifetimes.values()) life.signal.removeEventListener('abort', life.release);
  lifetimes.clear();
  recentByPlugin.clear();
  shown = [];
  changed();
}
