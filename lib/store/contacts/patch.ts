/**
 * RFC 8620 §5.3 patches: keys are JSON pointers without the leading slash, a
 * null value removes the property. Written so the common outbox can use the
 * same rules for its per-record merge.
 */

export type JsonObject = Record<string, unknown>;
export type Patch = Record<string, unknown>;

export class InvalidPatchError extends Error {
  constructor(path: string) {
    super(`Can't apply a patch at ${path}`);
    this.name = 'InvalidPatchError';
  }
}

function steps(path: string): string[] {
  return path.split('/').map((step) => step.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of the object with the patch applied. Throws when a path leads nowhere. */
export function applyPatch<T extends JsonObject>(object: T, patch: Patch): T {
  const root: JsonObject = { ...object };
  for (const [path, value] of Object.entries(patch)) {
    const parts = steps(path);
    let node = root;
    for (const step of parts.slice(0, -1)) {
      const next = node[step];
      if (!isObject(next)) throw new InvalidPatchError(path);
      const copy = { ...next };
      node[step] = copy;
      node = copy;
    }
    const last = parts[parts.length - 1];
    if (value === null) delete node[last];
    else node[last] = value;
  }
  return root as T;
}

/** One patch that does what the older one and then the newer one would do. */
export function mergePatches(older: Patch, newer: Patch): Patch {
  const merged: Patch = { ...older };
  for (const [path, value] of Object.entries(newer)) {
    // A newer write to a whole property replaces older writes below it.
    for (const key of Object.keys(merged)) {
      if (key.startsWith(`${path}/`)) delete merged[key];
    }
    // A newer write below an older whole-property write goes into that value.
    const parent = Object.keys(merged).find((key) => path.startsWith(`${key}/`));
    if (parent && isObject(merged[parent])) {
      const holder = applyPatch({ value: merged[parent] }, { [`value/${path.slice(parent.length + 1)}`]: value });
      merged[parent] = holder.value;
    } else {
      merged[path] = value;
    }
  }
  return merged;
}

/** The top-level properties a patch writes to. */
export function touchedProperties(patch: Patch): string[] {
  return [...new Set(Object.keys(patch).map((path) => steps(path)[0]))];
}

function isNothing(value: unknown): boolean {
  return value == null || (isObject(value) && Object.keys(value).length === 0);
}

/** Deep equality that ignores key order. Absent, null and an empty map count as the same. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b || (isNothing(a) && isNothing(b))) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => sameJson(a[key], b[key]));
  }
  return false;
}

/** Stalwart 1.0 keeps a data: URI in `media` as a blob: `uri` goes and `blobId` comes (measured). */
function inlineKeptAsBlob(wanted: JsonObject, actual: JsonObject): boolean {
  return typeof wanted.uri === 'string' && wanted.uri.startsWith('data:') && actual.uri == null && typeof actual.blobId === 'string';
}

/**
 * Whether `actual` is `wanted` as far as a server can tell. A key only the
 * server has is its own, unless `base` shows it was there before the edit:
 * then the edit meant to remove it, and it hasn't happened yet.
 */
export function coversJson(wanted: unknown, actual: unknown, base?: unknown): boolean {
  if (!isObject(wanted) || !isObject(actual)) return sameJson(wanted, actual);
  const before = isObject(base) ? base : {};
  const inline = inlineKeptAsBlob(wanted, actual);
  for (const key of Object.keys(wanted)) {
    if (inline && key === 'uri') continue;
    if (!coversJson(wanted[key], actual[key], before[key])) return false;
  }
  for (const key of Object.keys(actual)) {
    if (key in wanted || (inline && key === 'blobId')) continue;
    if (before[key] != null) return false;
  }
  return true;
}
