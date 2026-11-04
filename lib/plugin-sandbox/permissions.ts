import type { InstalledPlugin, Permission, SlotName } from '../plugin-types';
import { IMPLICIT_PERMISSIONS } from '../plugin-types';
import { hookSpec } from '../plugin-hook-catalog';
import { slotSpec } from '../plugin-slot-catalog';

/**
 * What an admin's install doesn't settle. These reach things on the user's own computer that
 * the admin has no say over, so the user is asked even for a plugin the admin put there, and
 * also when an update adds one to it.
 */
export const ALWAYS_ASK_USER: ReadonlySet<string> = new Set(['keystore']);

/**
 * Whether `plugin` may use `perm`: the manifest must declare it, and an
 * admin must have installed the plugin (managed) or the user must have
 * granted it in the consent dialog. Implicit permissions always pass.
 */
export function pluginHasPermission(plugin: InstalledPlugin, perm: Permission): boolean {
  if ((IMPLICIT_PERMISSIONS as readonly string[]).includes(perm)) return true;
  if (!plugin.permissions.includes(perm)) return false;
  // Defense-in-depth: even if the manifest declares a permission, the host
  // refuses it unless an admin has marked the plugin as managed, or the user
  // has explicitly granted it via the consent dialog.
  if (plugin.managed && !ALWAYS_ASK_USER.has(perm)) return true;
  return (plugin.grantedPermissions ?? []).includes(perm);
}

// ─── Hooks ────────────────────────────────────────────────────

// The permission each hook needs comes from the hook catalogue
// (lib/plugin-hook-catalog.ts). A hook hands the plugin data (an opened
// message, the outgoing mail) or lets it change what the host does with it,
// so registering one is as much an API call as `email.get` and is gated the
// same way. A hook missing from the catalogue is refused.

export function hookPermission(hookName: string): Permission | null {
  return hookSpec(hookName)?.permission ?? null;
}

export function mayRegisterHook(plugin: InstalledPlugin, hookName: string): boolean {
  const spec = hookSpec(hookName);
  if (!spec) return false;
  return pluginHasPermission(plugin, spec.permission)
    || (spec.alsoPermission !== undefined && pluginHasPermission(plugin, spec.alsoPermission));
}

/**
 * Whether one call of a hook may reach `plugin`: always for a hook with one
 * permission (registering checked it), else when the plugin holds the
 * permission this call's payload needs (a task's reminder: tasks:read).
 */
export function mayReceiveHookCall(plugin: InstalledPlugin, hookName: string, args: unknown[]): boolean {
  const needs = hookSpec(hookName)?.callPermission;
  return needs === undefined || pluginHasPermission(plugin, needs(args[0]));
}

// ─── Slots ────────────────────────────────────────────────────

// Which permissions let a plugin use each slot, and which props (or click
// context) it may see, come from the slot catalogue. A ui:* permission only
// lets a plugin draw somewhere; the message, event, contact or account the
// slot sits on is data, and stays behind the matching read permission. Props
// not listed in the catalogue are dropped, so a new prop at a call site is
// withheld until the catalogue names it.

export function slotPropsFor(
  plugin: InstalledPlugin,
  slot: SlotName,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const spec = slotSpec(slot);
  const allowed = spec?.props;
  if (allowed === '*') return props;
  if (!allowed) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) continue;
    const perm = allowed[key];
    if (perm && !pluginHasPermission(plugin, perm)) continue;
    const fields = spec?.fields?.[key];
    out[key] = fields ? fieldsFor(plugin, fields, value) : value;
  }
  return out;
}

// A prop made of parts with their own permissions (the app-side-panel's
// context: an event, a contact, files): only the parts the plugin may see,
// and none the catalogue doesn't name.
function fieldsFor(plugin: InstalledPlugin, fields: Record<string, Permission | null>, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [field, part] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const perm = fields[field];
    if (perm && !pluginHasPermission(plugin, perm)) continue;
    out[field] = part;
  }
  return out;
}

export function mayOfferSlot(plugin: InstalledPlugin, slot: string): boolean {
  const perms = slotSpec(slot)?.permissions ?? null;
  return !!perms && perms.some((perm) => pluginHasPermission(plugin, perm));
}
