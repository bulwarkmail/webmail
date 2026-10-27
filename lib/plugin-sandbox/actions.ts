// Buttons and menu entries plugins declare as data (`api.ui.setActions`).
// The host draws them in its own style on the surface named in the slot
// catalogue (kind: 'action'); a click goes back to the plugin with the
// surface's context, filtered by the plugin's permissions.

import { slotSpec } from '../plugin-slot-catalog';
import { isAllowedPluginCombo } from './shortcuts';

export interface PluginAction {
  id: string;
  label: string;
  /** Name of a host icon (see components/icons); unknown names show none. */
  icon?: string;
  /** Lower comes first; default 100. */
  order?: number;
  /** Show only for these folder roles (message surfaces), e.g. ["inbox"]. */
  mailboxRoles?: string[];
  /** Show only for attachments or files of these MIME types (prefix match, "image/"). */
  mimeTypes?: string[];
  /** A danger action is drawn in red. */
  danger?: boolean;
  /**
   * A key combination for the action ("Ctrl+Shift+A"), on surfaces that bind
   * one (composer-toolbar-actions: while the composer has focus). Needs Alt,
   * Ctrl/Cmd+Shift or Ctrl/Cmd+Alt, like plugin shortcuts.
   */
  shortcut?: string;
  /**
   * On menu surfaces (the composer's Options and Send menus): draw the entry
   * as a check item, ticked or not. The plugin updates it with setActions.
   */
  checked?: boolean;
  /** A second line under the label, on menu surfaces. Up to 120 characters. */
  description?: string;
  /**
   * A count on the action, e.g. how many filters it applies: on buttons a
   * bubble on the tinted button, as the search's filter button draws its
   * count; in menus after the label. 0 shows none, above 99 "99+".
   */
  badge?: number;
}

export interface RegisteredAction extends PluginAction {
  pluginId: string;
  pluginName: string;
}

export const MAX_ACTIONS_PER_SURFACE = 8;
const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,39}$/i;
const ICON_RE = /^[A-Za-z0-9-]{1,40}$/;
const ROLE_RE = /^[a-z]{1,20}$/;
const MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+*-]*$/i;

/** Surfaces that take actions, from the slot catalogue. */
export function isActionSurface(surface: string): boolean {
  return slotSpec(surface)?.kind === 'action';
}

/** Check and copy what a plugin sent; throws with a message the plugin sees. */
export function checkActions(value: unknown): PluginAction[] {
  if (!Array.isArray(value)) throw new Error('actions must be a list');
  if (value.length > MAX_ACTIONS_PER_SURFACE) throw new Error(`At most ${MAX_ACTIONS_PER_SURFACE} actions per surface`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`actions[${i}] must be an object`);
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) throw new Error(`actions[${i}].id is invalid`);
    if (seen.has(a.id)) throw new Error(`actions[${i}].id is used twice`);
    seen.add(a.id);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 60) throw new Error(`actions[${i}].label is required (max 60 characters)`);
    const out: PluginAction = { id: a.id, label: a.label.trim() };
    if (a.icon !== undefined) {
      if (typeof a.icon !== 'string' || !ICON_RE.test(a.icon)) throw new Error(`actions[${i}].icon is invalid`);
      out.icon = a.icon;
    }
    if (a.order !== undefined) {
      if (typeof a.order !== 'number' || !Number.isFinite(a.order)) throw new Error(`actions[${i}].order must be a number`);
      out.order = a.order;
    }
    if (a.mailboxRoles !== undefined) {
      if (!Array.isArray(a.mailboxRoles) || a.mailboxRoles.length > 10 || !a.mailboxRoles.every((r) => typeof r === 'string' && ROLE_RE.test(r))) {
        throw new Error(`actions[${i}].mailboxRoles must be a list of folder roles`);
      }
      out.mailboxRoles = [...a.mailboxRoles] as string[];
    }
    if (a.mimeTypes !== undefined) {
      if (!Array.isArray(a.mimeTypes) || a.mimeTypes.length > 20 || !a.mimeTypes.every((m) => typeof m === 'string' && MIME_RE.test(m))) {
        throw new Error(`actions[${i}].mimeTypes must be a list of MIME types`);
      }
      out.mimeTypes = (a.mimeTypes as string[]).map((m) => m.toLowerCase());
    }
    if (a.danger !== undefined) out.danger = a.danger === true;
    if (a.checked !== undefined) {
      if (typeof a.checked !== 'boolean') throw new Error(`actions[${i}].checked must be true or false`);
      out.checked = a.checked;
    }
    if (a.description !== undefined) {
      if (typeof a.description !== 'string' || a.description.length > 120) throw new Error(`actions[${i}].description must be a string of up to 120 characters`);
      if (a.description.trim()) out.description = a.description.trim();
    }
    if (a.badge !== undefined) {
      if (typeof a.badge !== 'number' || !Number.isSafeInteger(a.badge) || a.badge < 0) throw new Error(`actions[${i}].badge must be a whole number from 0`);
      if (a.badge > 0) out.badge = a.badge;
    }
    if (a.shortcut !== undefined) {
      if (typeof a.shortcut !== 'string' || a.shortcut.length > 30 || !isAllowedPluginCombo(a.shortcut)) {
        throw new Error(`actions[${i}].shortcut must use Alt, Ctrl+Shift or Ctrl+Alt`);
      }
      out.shortcut = a.shortcut;
    }
    return out;
  });
}

// pluginId → surface → actions
const registry = new Map<string, Map<string, RegisteredAction[]>>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, RegisteredAction[]>();

function changed(): void {
  snapshots.clear();
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribeActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setPluginActions(pluginId: string, pluginName: string, surface: string, actions: PluginAction[]): void {
  let surfaces = registry.get(pluginId);
  if (!surfaces) {
    surfaces = new Map();
    registry.set(pluginId, surfaces);
  }
  if (actions.length === 0) surfaces.delete(surface);
  else surfaces.set(surface, actions.map((a) => ({ ...a, pluginId, pluginName })));
  changed();
}

/** Drop everything a plugin declared (it was turned off or removed). */
export function clearPluginActions(pluginId: string): void {
  if (registry.delete(pluginId)) changed();
}

/**
 * The actions on a surface, in order. The same array is returned until
 * something changes, so it can feed useSyncExternalStore.
 */
export function actionsFor(surface: string): RegisteredAction[] {
  const cached = snapshots.get(surface);
  if (cached) return cached;
  const out: RegisteredAction[] = [];
  for (const surfaces of registry.values()) out.push(...(surfaces.get(surface) ?? []));
  out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  snapshots.set(surface, out);
  return out;
}

/** An action's badge as drawn: "99+" past two digits, like the other badges. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Whether an action applies to a folder role and/or a MIME type. */
export function actionApplies(action: PluginAction, ctx: { mailboxRole?: string | null; mimeType?: string | null }): boolean {
  if (action.mailboxRoles && ctx.mailboxRole !== undefined && !action.mailboxRoles.includes(ctx.mailboxRole ?? '')) return false;
  if (action.mimeTypes && ctx.mimeType !== undefined) {
    const type = (ctx.mimeType ?? '').toLowerCase();
    if (!action.mimeTypes.some((m) => (m.endsWith('/') || m.endsWith('/*') ? type.startsWith(m.replace(/\*$/, '')) : type === m))) return false;
  }
  return true;
}

/** Test helper. */
export function resetActions(): void {
  registry.clear();
  changed();
}

// ─── Clicks ───────────────────────────────────────────────────

/**
 * Delivers a click to the plugin. Set by the loader, which owns the running
 * plugins; it filters `context` by the surface's props and the plugin's
 * permissions before anything crosses into the sandbox.
 */
export type ActionDispatcher = (pluginId: string, surface: string, actionId: string, context: Record<string, unknown>) => Promise<void>;

let dispatcher: ActionDispatcher | null = null;

export function setActionDispatcher(next: ActionDispatcher | null): void {
  dispatcher = next;
}

export async function runAction(action: RegisteredAction, surface: string, context: Record<string, unknown>): Promise<void> {
  await runPluginAction(action.pluginId, surface, action.id, context);
}

/** A click on something a plugin gave as data elsewhere (a search result's entry). */
export async function runPluginAction(pluginId: string, surface: string, actionId: string, context: Record<string, unknown>): Promise<void> {
  if (!dispatcher) return;
  await dispatcher(pluginId, surface, actionId, context);
}
