import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getInstanceId } from './state';

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

let cache: LoginsFile | null = null;

function getDir(): string {
  return process.env.TELEMETRY_DATA_DIR || path.join(process.cwd(), 'data', 'telemetry');
}

function loginsPath(): string {
  return path.join(getDir(), 'logins.json');
}

async function ensureDir(): Promise<void> {
  const dir = getDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function loadFile(): Promise<LoginsFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(loginsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LoginsFile>;
    cache = Array.isArray(parsed?.records) ? { records: parsed.records as LoginRecord[] } : { records: [] };
  } catch {
    cache = { records: [] };
  }
  return cache;
}

async function saveFile(file: LoginsFile): Promise<void> {
  await ensureDir();
  cache = file;
  const tmp = loginsPath() + '.tmp';
  await writeFile(tmp, JSON.stringify(file), 'utf8');
  await rename(tmp, loginsPath());
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
 * are pruned on every write.
 */
export async function recordLogin(username: string, serverUrl: string): Promise<void> {
  if (!username || !serverUrl) return;
  try {
    const id = await hashIdentity(username, serverUrl);
    const file = await loadFile();
    const now = new Date().toISOString();
    const cutoff = Date.now() - RETENTION_MS;
    const next: LoginRecord[] = [];
    let updated = false;
    for (const rec of file.records) {
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
    await saveFile({ records: next });
  } catch (err) {
    logger.debug?.('telemetry: recordLogin failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Total distinct accounts seen in the 90-day retention window, plus those
 * with a login in the last 7 days.
 */
export async function getLoginCounts(): Promise<{ total: number; active7d: number }> {
  try {
    const file = await loadFile();
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
  } catch {
    return { total: 0, active7d: 0 };
  }
}
