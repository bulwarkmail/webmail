const MAX_LENGTH = 100;

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'nothing';
}

function shorten(text: string): string {
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

/** One line for an audit entry's detail; empty when it has none. */
export function formatAuditDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail || Object.keys(detail).length === 0) return '';
  if (detail.reason) return String(detail.reason);
  if (typeof detail.key === 'string') {
    // config.revert logs { key, oldValue }; other entries { key, old, new }.
    if ('oldValue' in detail) return shorten(`${detail.key}: reverted from ${show(detail.oldValue)}`);
    return shorten(`${detail.key}: ${show(detail.old)} → ${show(detail.new)}`);
  }
  if (Array.isArray(detail.changes)) {
    return shorten(detail.changes.map((c: { key?: unknown }) => String(c?.key)).join(', '));
  }
  if (detail.restrictionCount !== undefined) return `${detail.restrictionCount} restriction(s)`;
  return shorten(JSON.stringify(detail));
}
