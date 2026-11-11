import { SMART_FOLDERS_VERSION, type SmartFolder, type SmartFolderCondition } from './smart-folder-types';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key) && 'value' in Object.getOwnPropertyDescriptor(v, key)!);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const date = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + 'T00:00:00Z'))
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

export function isSmartFolderCondition(v: unknown): v is SmartFolderCondition {
  if (!record(v) || !keys(v, ['field', 'value'])) return false;
  switch (v.field) {
    case 'hasAttachment': return typeof v.value === 'boolean';
    case 'from': case 'subject': return text(v.value, 500);
    case 'after': case 'before': return date(v.value);
    default: return false;
  }
}

export function isSmartFolder(v: unknown): v is SmartFolder {
  return record(v) && keys(v, ['id', 'name', 'enabled', 'order', 'scope', 'match', 'conditions'])
    && typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v.id)
    && text(v.name, 100) && typeof v.enabled === 'boolean'
    && Number.isSafeInteger(v.order) && (v.order as number) >= 0
    && v.scope === 'active-account' && ['all', 'any', 'not'].includes(v.match as string)
    && Array.isArray(v.conditions) && v.conditions.length >= 1 && v.conditions.length <= 20
    && v.conditions.every(isSmartFolderCondition);
}

/** Reject the entire set: never weaken a malformed folder by dropping conditions. */
export function validSmartFolders(v: unknown, version: unknown = SMART_FOLDERS_VERSION): v is SmartFolder[] {
  return version === SMART_FOLDERS_VERSION && Array.isArray(v) && v.length <= 50
    && v.every(isSmartFolder) && new Set(v.map((f) => f.id)).size === v.length;
}
