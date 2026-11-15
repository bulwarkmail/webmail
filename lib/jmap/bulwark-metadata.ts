/**
 * Bulwark's own data in JMAP metadata (urn:ietf:params:jmap:metadata) of an
 * account's Inbox: shared tag definitions and team templates in a group
 * account, personal templates in the user's own account.
 *
 * What Stalwart v1.0.0 does (local-data/org-features-facts.md):
 * - vendor namespaces need a dot ("org.bulwarkmail" works, "bulwark" is
 *   refused); each namespace holds at most 8 KB, one mailbox at most 64 KB
 *   of shared and 16 KB of private metadata;
 * - `metadata/<namespace>` patches one namespace and leaves the others;
 * - every member of a group account sees its shared metadata; private
 *   metadata is per user.
 *
 * So every item gets a namespace of its own, `org.bulwarkmail.<key>`. 0.16
 * has no metadata, and a pre-release 1.0 build advertises it but drops the
 * connection on Mailbox/get with `metadata`; the calls go in a request of
 * their own and any failure means "not supported" for that account.
 */

export const METADATA_CAPABILITY = 'urn:ietf:params:jmap:metadata';
export const BULWARK_NAMESPACE = 'org.bulwarkmail';
/** Largest value Stalwart's default config takes in one namespace. */
export const MAX_METADATA_ENTRY_BYTES = 8192;

const KEY_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

export class MetadataTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataTooLargeError';
  }
}

/** The server refused a metadata change; `type` is its SetError type (`forbidden`, `invalidProperties`, ...). */
export class MetadataRefusedError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
    this.name = 'MetadataRefusedError';
  }
}

export class MetadataUnsupportedError extends Error {
  constructor(message = 'This server keeps no metadata for Bulwark') {
    super(message);
    this.name = 'MetadataUnsupportedError';
  }
}

/** A patch inside an entry whose parent value doesn't exist (yet, or any more). */
export class MetadataPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataPatchError';
  }
}

/**
 * One segment of a patch path inside a metadata entry, escaped the JSON
 * Pointer way (`~` as `~0`, `/` as `~1`), which Stalwart v1.0.0 decodes:
 * a tag id `work/clients` is the segment `work~1clients`.
 */
export function escapeMetadataPathSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** `tags`, `template.<id>`: lowercase, digits, dashes, dot-separated. */
export function isValidMetadataKey(key: string): boolean {
  return key.length <= 120 && KEY_RE.test(key);
}

export function namespaceFor(key: string): string {
  if (!isValidMetadataKey(key)) throw new Error(`Invalid metadata key: ${key}`);
  return `${BULWARK_NAMESPACE}.${key}`;
}

/**
 * Whether the account's capabilities offer vendor-namespaced metadata on
 * mailboxes. Says nothing about whether the server really implements it.
 */
export function advertisesMailboxMetadata(accountCapabilities: Record<string, unknown> | undefined): boolean {
  const cap = accountCapabilities?.[METADATA_CAPABILITY] as
    | { dataTypes?: Record<string, { supportsVendorNamespaces?: boolean; supportsPrivate?: boolean }> }
    | undefined;
  return cap?.dataTypes?.Mailbox?.supportsVendorNamespaces === true;
}

/** Whether the account also offers the user's own (private) metadata on mailboxes. */
export function advertisesPrivateMailboxMetadata(accountCapabilities: Record<string, unknown> | undefined): boolean {
  const cap = accountCapabilities?.[METADATA_CAPABILITY] as
    | { dataTypes?: Record<string, { supportsVendorNamespaces?: boolean; supportsPrivate?: boolean }> }
    | undefined;
  const mailbox = cap?.dataTypes?.Mailbox;
  return mailbox?.supportsVendorNamespaces === true && mailbox.supportsPrivate === true;
}

/** One change of a metadata update: a whole entry, or one member of an entry that exists. */
export interface BulwarkMetadataChange {
  key: string;
  /** A member of the entry's object; the server refuses it when the entry doesn't exist. */
  member?: string;
  /** Null removes the entry or the member. */
  value: unknown;
}

/** The Mailbox/set patch path of a change, in `metadata` or `privateMetadata`. */
export function metadataChangePath(change: BulwarkMetadataChange, options?: { private?: boolean }): string {
  const entry = `${options?.private ? 'privateMetadata' : 'metadata'}/${namespaceFor(change.key)}`;
  return change.member === undefined ? entry : `${entry}/${escapeMetadataPathSegment(change.member)}`;
}

/** Bulwark's entries of a `metadata` or `privateMetadata` object, by key. */
export function bulwarkEntries(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const prefix = `${BULWARK_NAMESPACE}.`;
  const out: Record<string, unknown> = {};
  for (const [namespace, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (namespace.startsWith(prefix)) out[namespace.slice(prefix.length)] = value;
  }
  return out;
}

/** The size Stalwart counts for a value: its JSON in UTF-8. */
export function metadataValueBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
