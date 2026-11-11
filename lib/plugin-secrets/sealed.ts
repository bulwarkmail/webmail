// A plugin setting that is stored as a secret.
//
// A stored value is a secret unless it is known to be plain: entered into a
// field that was declared with an ordinary kind at that moment. A value
// entered into a `secret` field, one whose key the installed version does
// not declare, and one left behind with nothing installed are secrets, and
// stay so whatever a later version of the plugin declares for the key. The
// store keeps the mark with the value (lib/admin/plugin-config.ts) and
// hands a secret to readers sealed. A sealed value does not serialise (JSON, string
// conversion and logging give nothing), so a reader that passes settings on
// cannot hand it out by accident. Only `settingForServer` opens it, and only
// while the installed version still declares the field `secret`: for the
// proxy, which sends it to the credential's server, and for the admin's own
// settings page. Under any other declaration the setting reads as unset until
// an admin enters a new value.

const SEALED: unique symbol = Symbol.for('bulwark.pluginConfig.sealed');

export interface SealedValue {
  readonly [SEALED]: () => unknown;
  toJSON(): undefined;
  toString(): string;
}

/** Wrap a value that was stored as a secret. */
export function seal(value: unknown): SealedValue {
  return Object.freeze({
    [SEALED]: () => value,
    toJSON: () => undefined,
    toString: () => '',
  });
}

export function isSealed(value: unknown): value is SealedValue {
  return typeof value === 'object' && value !== null
    && typeof (value as { [SEALED]?: unknown })[SEALED] === 'function';
}

/** How a plugin declares one setting, as far as secrecy goes. */
export interface SettingDeclaration {
  type?: string;
}

/** A schema's own entry for a key (never an inherited property such as `constructor`). */
export function declarationOf<T extends SettingDeclaration>(
  schema: Record<string, T> | null | undefined,
  key: string,
): T | undefined {
  return schema && Object.hasOwn(schema, key) ? schema[key] : undefined;
}

const ORDINARY_KINDS = new Set(['string', 'boolean', 'number', 'select']);

/**
 * Whether a setting is declared with an ordinary kind: one whose value the
 * plugin and any signed-in user may read. A `secret` field, a kind this
 * version doesn't know and a key that isn't declared at all are not.
 */
export function isOrdinarySetting(declaration: SettingDeclaration | undefined): boolean {
  return !!declaration && typeof declaration.type === 'string' && ORDINARY_KINDS.has(declaration.type);
}

/** The keys a settings schema declares as `secret`. */
export function secretFields(schema: Record<string, SettingDeclaration> | null | undefined): string[] {
  if (!schema || typeof schema !== 'object') return [];
  return Object.keys(schema).filter((key) => schema[key]?.type === 'secret');
}

/**
 * A stored setting for the server's own use (never for a plugin or a user's
 * browser): a value stored as a secret is opened only while its field is
 * declared `secret`, and is undefined otherwise. Any other value is returned
 * as stored.
 */
export function settingForServer(stored: unknown, declaration: SettingDeclaration | undefined): unknown {
  if (!isSealed(stored)) return stored;
  return declaration?.type === 'secret' ? stored[SEALED]() : undefined;
}

/**
 * The settings any signed-in user, and so the plugin itself, may read: the
 * ones the installed version declares with an ordinary kind, minus every
 * value that was stored as a secret.
 */
export function ordinarySettings(
  config: Record<string, unknown>,
  schema: Record<string, SettingDeclaration> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const declaration = declarationOf(schema, key);
    if (!declaration || declaration.type === 'secret' || isSealed(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The settings for the admin's own page: every stored value, a secret
 * included while its field is still a secret. A value stored as a secret
 * whose field is declared otherwise now (or not at all) is left out.
 */
export function adminSettings(
  config: Record<string, unknown>,
  schema: Record<string, SettingDeclaration> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const opened = settingForServer(value, declarationOf(schema, key));
    if (opened !== undefined) out[key] = opened;
  }
  return out;
}
