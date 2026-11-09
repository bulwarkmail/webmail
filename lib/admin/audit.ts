import { logger } from '@/lib/logger';
import { getStore, isSharedMode, type AppendLog, type LogOptions } from '@/lib/shared-store';
import { ensureStateDir, getStatePath } from './paths';
import { SENSITIVE_CONFIG_KEYS, type AuditEntry } from './types';

const REDACTED = '[redacted]';

/**
 * A config value as it may appear in the audit log. The dashboard hides the
 * session secret and the OAuth client secrets behind `hasValue` flags so a
 * stolen admin session cannot read them, so the log of a change must not
 * hand them out either (and must not keep them on disk past a rotation).
 */
export function redactConfigValueForAudit(key: string, value: unknown): unknown {
  if (SENSITIVE_CONFIG_KEYS.has(key)) {
    return typeof value === 'string' && value.length > 0 ? REDACTED : value;
  }
  if (key === 'jmapServers' && Array.isArray(value)) {
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const e = entry as Record<string, unknown>;
      if (!e.oauth || typeof e.oauth !== 'object') return entry;
      const o = e.oauth as Record<string, unknown>;
      if (typeof o.clientSecret !== 'string' || o.clientSecret.length === 0) return entry;
      return { ...e, oauth: { ...o, clientSecret: REDACTED } };
    });
  }
  return value;
}

/**
 * Apply {@link redactConfigValueForAudit} to the detail of a config change,
 * whatever shape wrote it. Entries written before the redaction existed are
 * cleaned on the way out as well.
 */
export function redactAuditDetail(action: string, detail: Record<string, unknown>): Record<string, unknown> {
  if (action === 'config.update' && Array.isArray(detail.changes)) {
    return {
      ...detail,
      changes: detail.changes.map((change) => {
        if (!change || typeof change !== 'object') return change;
        const c = change as Record<string, unknown>;
        if (typeof c.key !== 'string') return change;
        return {
          ...c,
          ...('old' in c ? { old: redactConfigValueForAudit(c.key, c.old) } : {}),
          ...('new' in c ? { new: redactConfigValueForAudit(c.key, c.new) } : {}),
        };
      }),
    };
  }
  if (action === 'config.revert' && typeof detail.key === 'string' && 'oldValue' in detail) {
    return { ...detail, oldValue: redactConfigValueForAudit(detail.key, detail.oldValue) };
  }
  return detail;
}

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATIONS = 3;
const AUDIT_LOG_FILE = 'audit.log';

/**
 * The audit log (#1066). Local mode: <state dir>/audit.log, rotated at
 * 10 MB to .1 … .3, of which only the current file is read, as before.
 * Shared mode: one log for every replica, keeping the newest 50 000
 * entries (about what one 10 MB file holds).
 */
export const AUDIT_LOG_OPTIONS: LogOptions = {
  local: { path: () => getStatePath(AUDIT_LOG_FILE), maxBytes: MAX_LOG_SIZE, rotations: MAX_ROTATIONS },
  maxEntries: 50_000,
};

function auditStore(): AppendLog {
  return getStore().log('audit', AUDIT_LOG_OPTIONS);
}

/**
 * Append an audit entry to the admin audit log. Stored under the state dir
 * so it remains writable when the config dir is mounted read-only.
 */
export async function auditLog(action: string, detail: Record<string, unknown>, ip: string): Promise<void> {
  const shared = isSharedMode();
  if (!shared) await ensureStateDir();

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    action,
    detail: redactAuditDetail(action, detail),
    ip,
  };

  // Also in the server log, so LOG_FORMAT=json shippers see admin actions.
  // The audit file below stays the record the admin panel reads.
  logger.info(`audit: ${action}`, { audit: entry });

  try {
    // One line per entry; the store rotates the local file (audit.log.3 →
    // deleted, .2 → .3, .1 → .2, audit.log → .1) once it passes 10 MB.
    await auditStore().append(JSON.stringify(entry));
  } catch (error) {
    logger.error('Failed to write audit log', {
      error: error instanceof Error ? error.message : 'Unknown error',
      // With a shared store that is down, the entry is kept in the server log.
      ...(shared ? { entry } : {}),
    });
  }
}

/**
 * Read audit log entries, newest first. Supports pagination.
 */
export async function readAuditLog(page: number = 1, limit: number = 50, actionFilter?: string): Promise<{ entries: AuditEntry[]; total: number }> {
  try {
    const lines = await auditStore().readAll();

    let entries: AuditEntry[] = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((e): e is AuditEntry => e !== null && typeof e === 'object')
      .map((e) => (e.detail && typeof e.detail === 'object' ? { ...e, detail: redactAuditDetail(e.action, e.detail) } : e));

    if (actionFilter) {
      entries = entries.filter(e => e.action === actionFilter);
    }

    const total = entries.length;
    entries.reverse();
    const start = (page - 1) * limit;
    return { entries: entries.slice(start, start + limit), total };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], total: 0 };
    }
    logger.warn('Failed to read audit log', { error: error instanceof Error ? error.message : 'Unknown error' });
    return { entries: [], total: 0 };
  }
}
