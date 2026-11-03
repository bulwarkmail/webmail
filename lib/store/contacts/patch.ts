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

/** Deep equality that ignores key order. Absent and null count as the same. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => sameJson(a[key], b[key]));
  }
  return false;
}

/** Whether `actual` holds everything in `wanted`. A server may add properties of its own. */
export function coversJson(wanted: unknown, actual: unknown): boolean {
  if (isObject(wanted) && isObject(actual)) {
    return Object.keys(wanted).every((key) => coversJson(wanted[key], actual[key]));
  }
  return sameJson(wanted, actual);
}
