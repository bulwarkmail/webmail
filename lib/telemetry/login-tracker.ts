import { createHmac } from 'node:crypto';
import { logger } from '@/lib/logger';
import { isStoreUnavailableError } from '@/lib/shared-store/types';
import { getInstanceId, telemetryDocs } from './state';

// We never store usernames or server URLs in the clear. Each login is
// recorded as HMAC-SHA256(username + '@' + serverUrl, instance_id), so the
// file on disk cannot be cross-correlated with any other instance and is
// not PII even if leaked.

interface LoginRecord {
  id: string;
  lastLoginAt: string;
}

interface LoginsFile {
  records: LoginRecord[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** `logins.json` in the telemetry collection (#1066): one list for every replica. */
const LOGINS_DOC = 'logins.json';

function parse(data: Buffer | null): LoginsFile {
  if (!data) return { records: [] };
  try {
    const parsed = JSON.parse(data.toString('utf8')) as Partial<LoginsFile>;
    return Array.isArray(parsed?.records) ? { records: parsed.records as LoginRecord[] } : { records: [] };
  } catch {
    return { records: [] };
  }
}

function normalizeServer(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '').toLowerCase();
}

async function hashIdentity(username: string, serverUrl: string): Promise<string> {
  const instanceId = await getInstanceId();
  const subject = `${username.trim().toLowerCase()}@${normalizeServer(serverUrl)}`;
  return createHmac('sha256', instanceId).update(subject).digest('hex').slice(0, 32);
}

/**
 * Record a successful login. Best-effort; never throws. Updates the
 * existing record's timestamp if the same identity has logged in before,
 * otherwise appends a new record. Records older than the retention window
 * are pruned on every write. Read and written in one step, so logins on
 * several replicas at once all count.
 */
export async function recordLogin(username: string, serverUrl: string): Promise<void> {
  if (!username || !serverUrl) return;
  try {
    const id = await hashIdentity(username, serverUrl);
    const now = new Date().toISOString();
    await telemetryDocs().update(LOGINS_DOC, (current) => {
      const cutoff = Date.now() - RETENTION_MS;
      const next: LoginRecord[] = [];
      let updated = false;
      for (const rec of parse(current).records) {
        const ts = new Date(rec.lastLoginAt).getTime();
        if (Number.isNaN(ts) || ts < cutoff) continue;
        if (rec.id === id) {
          next.push({ id, lastLoginAt: now });
          updated = true;
        } else {
          next.push(rec);
        }
      }
      if (!updated) next.push({ id, lastLoginAt: now });
      return JSON.stringify({ records: next });
    });
  } catch (err) {
    logger.debug?.('telemetry: recordLogin failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Total distinct accounts seen in the 90-day retention window, plus those
 * with a login in the last 7 days. Read from the store each time, so every
 * replica reports the same numbers. Throws while the shared store is down
 * rather than reporting zero accounts.
 */
export async function getLoginCounts(): Promise<{ total: number; active7d: number }> {
  try {
    const file = parse((await telemetryDocs().get(LOGINS_DOC))?.data ?? null);
    const cutoff = Date.now() - RETENTION_MS;
    const sevenAgo = Date.now() - SEVEN_DAYS_MS;
    let total = 0;
    let active7d = 0;
    for (const rec of file.records) {
      const ts = new Date(rec.lastLoginAt).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      total++;
      if (ts >= sevenAgo) active7d++;
    }
    return { total, active7d };
  } catch (err) {
    if (isStoreUnavailableError(err)) throw err;
    return { total: 0, active7d: 0 };
  }
}
