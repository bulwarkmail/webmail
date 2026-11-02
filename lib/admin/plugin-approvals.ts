// Server-side admin plugin-approval store.
//
// Closes the "C4" audit finding: previously a plugin's `adminApproved` flag
// was client-only, so a malicious user could enable a plugin past the policy
// gate via DevTools. The server now tracks per-(pluginId, bundleHash) status
// and the `enablePlugin` flow consults it before letting a non-managed plugin
// run.
//
// Each entry has one of three states: 'pending' (user installed, waiting for
// admin), 'approved' (admin signed off), 'denied' (admin refused - kept so we
// don't keep asking).
//
// Stored in C/plugin-approvals.json, or the shared store in shared mode
// (#1066). Every change goes through update() against the stored document,
// so requests and decisions arriving at once (on one instance or several)
// all stay, then announces area `approvals`: every replica re-reads its copy,
// which also feeds the plugin-secrets credential gate (known-plugins.ts).

import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { announceChange, onSharedChange } from '@/lib/shared-store/changes';
import { ensureConfigDir, assertWritable } from './paths';
import { isStoreUnavailable } from './admin-store';
import { pluginApprovalDocs } from './extension-store';
import type { CredentialSpec } from '@/lib/plugin-secrets/credentials';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalEntry {
  pluginId: string;
  bundleHash: string;
  status: ApprovalStatus;
  /** Snapshot of the manifest at request time. */
  manifest: {
    name?: string;
    version?: string;
    author?: string;
    description?: string;
    permissions?: string[];
    httpOrigins?: string[];
    apiPostPaths?: string[];
    /** The credentials it may use through the plugin proxy (lib/plugin-secrets). */
    credentials?: Record<string, CredentialSpec>;
  };
  requestedBy: string;     // JMAP username who triggered the request
  requestedAt: string;     // ISO 8601
  decidedBy?: string;      // admin username (set on approve/deny)
  decidedAt?: string;
  /** Size of the package kept for review (plugin-approvals/<id>-<hash>.zip), when one is. */
  packageBytes?: number;
}

interface ApprovalsFile {
  entries: ApprovalEntry[];
}

const APPROVALS_FILE = 'plugin-approvals.json';
const MAX_ENTRIES = 500; // hard cap so a misbehaving client can't grow the file unboundedly
/** Open requests one user may have at a time, so one account can't crowd out the rest. */
export const MAX_PENDING_PER_USER = 10;

/** The package a user asked to have approved, kept so the admin can read the code. */
function bundleId(pluginId: string, bundleHash: string): string {
  return `plugin-approvals/${pluginId}-${bundleHash}.zip`;
}

/**
 * The packages kept for review hold at most this much together. Beyond it
 * the packages of the longest-decided requests go first; pending ones are
 * always kept (the admin still has to read them). Packages stored before
 * their size was recorded aren't counted.
 */
let maxPackageBytes = 100 * 1024 * 1024;

/** A smaller cap (tests). */
export function setApprovalPackageCapForTests(bytes: number | null): void {
  maxPackageBytes = bytes ?? 100 * 1024 * 1024;
}

export async function saveApprovalBundle(pluginId: string, bundleHash: string, zip: Uint8Array): Promise<void> {
  assertWritable('plugin-approvals.saveBundle');
  await pluginApprovalDocs().put(bundleId(pluginId, bundleHash), Buffer.from(zip));
  let dropped: Array<{ pluginId: string; bundleHash: string }> = [];
  await changeStored((file) => {
    dropped = [];
    let changed = false;
    const entry = findEntry(file, pluginId, bundleHash);
    if (entry && entry.packageBytes !== zip.byteLength) {
      entry.packageBytes = zip.byteLength;
      changed = true;
    }
    let total = file.entries.reduce((sum, e) => sum + (e.packageBytes ?? 0), 0);
    const oldestDecidedFirst = file.entries
      .filter((e) => e.status !== 'pending' && e.packageBytes)
      .sort((a, b) => (a.decidedAt ?? a.requestedAt).localeCompare(b.decidedAt ?? b.requestedAt));
    for (const old of oldestDecidedFirst) {
      if (total <= maxPackageBytes) break;
      total -= old.packageBytes!;
      delete old.packageBytes;
      dropped.push({ pluginId: old.pluginId, bundleHash: old.bundleHash });
      changed = true;
    }
    return changed;
  });
  for (const old of dropped) await deleteApprovalBundle(old.pluginId, old.bundleHash);
}

export async function readApprovalBundle(pluginId: string, bundleHash: string): Promise<Uint8Array | null> {
  try {
    const doc = await pluginApprovalDocs().get(bundleId(pluginId, bundleHash));
    return doc ? new Uint8Array(doc.data) : null;
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    return null;
  }
}

async function deleteApprovalBundle(pluginId: string, bundleHash: string): Promise<void> {
  try { await pluginApprovalDocs().delete(bundleId(pluginId, bundleHash)); } catch { /* none */ }
}

// The copy every module copy (admin routes, the approval-status route, the
// plugin-secrets gate) reads, on globalThis. In shared mode another
// replica's change marks it stale; while the store is down the stale copy
// keeps being served.
interface ApprovalsGlobals {
  cached: ApprovalsFile | null;
  stale: boolean;
  loading: Promise<void> | null;
}
const GLOBAL_KEY = Symbol.for('bulwark.admin.pluginApprovals');

function approvalsGlobals(): ApprovalsGlobals {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ApprovalsGlobals };
  return (g[GLOBAL_KEY] ??= { cached: null, stale: false, loading: null });
}

onSharedChange('approvals', (origin) => {
  // This process's own writes already replaced the copy.
  if (origin === 'remote') approvalsGlobals().stale = true;
});

function parseFile(data: Buffer | null): ApprovalsFile {
  if (!data) return { entries: [] };
  try {
    const parsed = JSON.parse(data.toString('utf-8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isWellFormed) };
  } catch (err) {
    logger.warn('[plugin-approvals] failed to read file', { error: err instanceof Error ? err.message : String(err) });
    return { entries: [] };
  }
}

async function loadStored(): Promise<ApprovalsFile> {
  if (!isSharedMode()) await ensureConfigDir();
  let data: Buffer | null;
  try {
    data = (await pluginApprovalDocs().get(APPROVALS_FILE))?.data ?? null;
  } catch (err) {
    if (isStoreUnavailable(err)) throw err;
    logger.warn('[plugin-approvals] failed to read file', { error: err instanceof Error ? err.message : String(err) });
    return { entries: [] };
  }
  return parseFile(data);
}

async function ensureLoaded(): Promise<ApprovalsFile> {
  const g = approvalsGlobals();
  if (g.cached && !g.stale) return g.cached;
  if (!g.loading) {
    g.stale = false;
    g.loading = (async () => {
      try {
        g.cached = await loadStored();
      } catch (err) {
        // Store down: keep serving the copy we have, read again next time.
        if (!(isStoreUnavailable(err) && g.cached)) throw err;
        g.stale = true;
      } finally {
        g.loading = null;
      }
    })();
  }
  await g.loading;
  return g.cached!;
}

/**
 * Change the stored file with `change`, which edits the parsed file and
 * returns true when it changed something. It may run more than once.
 */
async function changeStored(change: (file: ApprovalsFile) => boolean): Promise<boolean> {
  let changed = false;
  const result = await pluginApprovalDocs().update(APPROVALS_FILE, (current) => {
    const file = parseFile(current);
    changed = change(file);
    return changed ? JSON.stringify(file, null, 2) : undefined;
  });
  if (changed && result.data) {
    approvalsGlobals().cached = parseFile(result.data);
    approvalsGlobals().stale = false;
    await announceChange('approvals');
  }
  return changed;
}

function isWellFormed(value: unknown): value is ApprovalEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pluginId === 'string' &&
    typeof v.bundleHash === 'string' &&
    (v.status === 'pending' || v.status === 'approved' || v.status === 'denied') &&
    typeof v.requestedBy === 'string' &&
    typeof v.requestedAt === 'string' &&
    typeof v.manifest === 'object' && v.manifest !== null
  );
}

function findEntry(file: ApprovalsFile, pluginId: string, bundleHash: string): ApprovalEntry | undefined {
  return file.entries.find(e => e.pluginId === pluginId && e.bundleHash === bundleHash);
}

// ─── Public API ──────────────────────────────────────────────

export async function listApprovals(): Promise<ApprovalEntry[]> {
  return [...(await ensureLoaded()).entries];
}

export async function getApprovalStatus(pluginId: string, bundleHash: string): Promise<{ status: ApprovalStatus | 'not-requested'; decidedAt?: string }> {
  const entry = findEntry(await ensureLoaded(), pluginId, bundleHash);
  if (!entry) return { status: 'not-requested' };
  return { status: entry.status, decidedAt: entry.decidedAt };
}

export async function requestApproval(
  pluginId: string,
  bundleHash: string,
  manifest: ApprovalEntry['manifest'],
  requestedBy: string,
): Promise<ApprovalEntry> {
  if (!pluginId || !bundleHash) throw new Error('pluginId and bundleHash required');
  const existing = findEntry(await ensureLoaded(), pluginId, bundleHash);
  if (existing) return existing;
  assertWritable('request plugin approval');
  const requestedAt = new Date().toISOString();
  let result: ApprovalEntry | null = null;
  let dropped: ApprovalEntry | null = null;
  await changeStored((file) => {
    dropped = null;
    const stored = findEntry(file, pluginId, bundleHash);
    if (stored) {
      result = stored;
      return false;
    }
    const pendingByUser = file.entries.filter(e => e.status === 'pending' && e.requestedBy === requestedBy).length;
    if (pendingByUser >= MAX_PENDING_PER_USER) {
      throw new ApprovalLimitError(`You already have ${MAX_PENDING_PER_USER} plugins waiting for approval`);
    }
    if (file.entries.length >= MAX_ENTRIES) {
      // Drop the oldest pending entry so a new request can land. Approved/denied
      // entries are preserved.
      const oldestPendingIdx = file.entries.findIndex(e => e.status === 'pending');
      if (oldestPendingIdx < 0) {
        throw new ApprovalLimitError('The approval queue is full; ask an administrator to clear old requests');
      }
      [dropped] = file.entries.splice(oldestPendingIdx, 1);
    }
    const entry: ApprovalEntry = {
      pluginId,
      bundleHash,
      status: 'pending',
      manifest,
      requestedBy,
      requestedAt,
    };
    file.entries.push(entry);
    result = entry;
    return true;
  });
  const gone = dropped as ApprovalEntry | null;
  if (gone) await deleteApprovalBundle(gone.pluginId, gone.bundleHash);
  return result!;
}

export async function decideApproval(
  pluginId: string,
  bundleHash: string,
  decision: 'approved' | 'denied',
  decidedBy: string,
): Promise<ApprovalEntry> {
  assertWritable('decide plugin approval');
  const decidedAt = new Date().toISOString();
  let decided: ApprovalEntry | null = null;
  await changeStored((file) => {
    const entry = findEntry(file, pluginId, bundleHash);
    if (!entry) throw new Error('approval entry not found');
    entry.status = decision;
    entry.decidedAt = decidedAt;
    entry.decidedBy = decidedBy;
    decided = entry;
    return true;
  });
  return decided!;
}

export async function revokeApproval(pluginId: string, bundleHash: string): Promise<void> {
  assertWritable('revoke plugin approval');
  const removed = await changeStored((file) => {
    const idx = file.entries.findIndex(e => e.pluginId === pluginId && e.bundleHash === bundleHash);
    if (idx < 0) return false;
    file.entries.splice(idx, 1);
    return true;
  });
  if (removed) await deleteApprovalBundle(pluginId, bundleHash);
}

export class ApprovalLimitError extends Error {}

/** Forget the copy in memory (tests: a fresh process). */
export function resetApprovalsCacheForTests(): void {
  const g = approvalsGlobals();
  g.cached = null;
  g.stale = false;
  g.loading = null;
}
