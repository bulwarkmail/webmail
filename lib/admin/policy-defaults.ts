/** At most this many entries in a list default, each at most this long. */
const MAX_LIST_ENTRIES = 50;
const MAX_LIST_ENTRY_LENGTH = 100;

/**
 * `policy.defaults` (#1248): the values users start with for settings they
 * have not chosen themselves. policy.json is written by hand and the server
 * does not know the client's settings, so only the shape is checked here: a
 * plain object of plain values (boolean, finite number, string) or short
 * lists of strings (#1564). The client checks each key and value against its
 * own settings before applying it (adminPolicyPatch in
 * stores/settings-store.ts).
 */
export function sanitizePolicyDefaults(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.length <= MAX_LIST_ENTRIES &&
      value.every((entry) => typeof entry === 'string' && entry.length <= MAX_LIST_ENTRY_LENGTH)
    ) {
      out[key] = [...value];
    }
  }
  return out;
}
