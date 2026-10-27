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

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import nodePath from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '@/lib/logger';
import { ensureConfigDir, getConfigPath, assertWritable } from './paths';
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
}

interface ApprovalsFile {
  entries: ApprovalEntry[];
}

const APPROVALS_FILE = 'plugin-approvals.json';
const MAX_ENTRIES = 500; // hard cap so a misbehaving client can't grow the file unboundedly
/** Open requests one user may have at a time, so one account can't crowd out the rest. */
export const MAX_PENDING_PER_USER = 10;

/** The package a user asked to have approved, kept so the admin can read the code. */
function bundlePath(pluginId: string, bundleHash: string): string {
  return nodePath.join(getConfigPath('plugin-approvals'), `${pluginId}-${bundleHash}.zip`);
}

export async function saveApprovalBundle(pluginId: string, bundleHash: string, zip: Uint8Array): Promise<void> {
  assertWritable('plugin-approvals.saveBundle');
  await mkdir(getConfigPath('plugin-approvals'), { recursive: true });
  await writeFile(bundlePath(pluginId, bundleHash), zip);
}

export async function readApprovalBundle(pluginId: string, bundleHash: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(bundlePath(pluginId, bundleHash)));
  } catch {
    return null;
  }
}

async function deleteApprovalBundle(pluginId: string, bundleHash: string): Promise<void> {
  try { await unlink(bundlePath(pluginId, bundleHash)); } catch { /* none */ }
}

let cached: ApprovalsFile | null = null;
let loadPromise: Promise<void> | null = null;

async function loadFromDisk(): Promise<ApprovalsFile> {
  await ensureConfigDir();
  const path = getConfigPath(APPROVALS_FILE);
  if (!existsSync(path)) return { entries: [] };
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.filter(isWellFormed) };
  } catch (err) {
    logger.warn('[plugin-approvals] failed to read file', { error: err instanceof Error ? err.message : String(err) });
    return { entries: [] };
  }
}

async function ensureLoaded(): Promise<void> {
  if (cached !== null) return;
  if (!loadPromise) {
    loadPromise = (async () => { cached = await loadFromDisk(); })();
  }
  await loadPromise;
}

// Writes run one after another. Requests of several users at once shared the
// one ".tmp" file, and every rename after the first failed: the user got a
// 500 and the server kept no ZIP for the admin to review.
let flushQueue: Promise<void> = Promise.resolve();

function flushToDisk(): Promise<void> {
  const run = flushQueue.then(writeToDisk, writeToDisk);
  flushQueue = run.catch(() => {});
  return run;
}

async function writeToDisk(): Promise<void> {
  if (!cached) return;
  await ensureConfigDir();
  assertWritable('plugin-approvals.flushToDisk');
  const path = getConfigPath(APPROVALS_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cached, null, 2), 'utf-8');
  await rename(tmp, path);
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
  await ensureLoaded();
  return [...cached!.entries];
}

export async function getApprovalStatus(pluginId: string, bundleHash: string): Promise<{ status: ApprovalStatus | 'not-requested'; decidedAt?: string }> {
  await ensureLoaded();
  const entry = findEntry(cached!, pluginId, bundleHash);
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
  await ensureLoaded();
  const file = cached!;
  const existing = findEntry(file, pluginId, bundleHash);
  if (existing) return existing;
  assertWritable('request plugin approval');
  const pendingByUser = file.entries.filter(e => e.status === 'pending' && e.requestedBy === requestedBy).length;
  if (pendingByUser >= MAX_PENDING_PER_USER) {
    throw new ApprovalLimitError(`You already have ${MAX_PENDING_PER_USER} plugins waiting for approval`);
  }
  if (file.entries.length >= MAX_ENTRIES) {
    // Drop the oldest pending entry so a new request can land. Approved/denied
    // entries are preserved.
    const oldestPendingIdx = file.entries.findIndex(e => e.status === 'pending');
    if (oldestPendingIdx >= 0) {
      const [dropped] = file.entries.splice(oldestPendingIdx, 1);
      await deleteApprovalBundle(dropped.pluginId, dropped.bundleHash);
    } else {
      throw new ApprovalLimitError('The approval queue is full; ask an administrator to clear old requests');
    }
  }
  const entry: ApprovalEntry = {
    pluginId,
    bundleHash,
    status: 'pending',
    manifest,
    requestedBy,
    requestedAt: new Date().toISOString(),
  };
  file.entries.push(entry);
  await flushToDisk();
  return entry;
}

export async function decideApproval(
  pluginId: string,
  bundleHash: string,
  decision: 'approved' | 'denied',
  decidedBy: string,
): Promise<ApprovalEntry> {
  assertWritable('decide plugin approval');
  await ensureLoaded();
  const file = cached!;
  const entry = findEntry(file, pluginId, bundleHash);
  if (!entry) throw new Error('approval entry not found');
  entry.status = decision;
  entry.decidedAt = new Date().toISOString();
  entry.decidedBy = decidedBy;
  await flushToDisk();
  return entry;
}

export async function revokeApproval(pluginId: string, bundleHash: string): Promise<void> {
  assertWritable('revoke plugin approval');
  await ensureLoaded();
  const file = cached!;
  const idx = file.entries.findIndex(e => e.pluginId === pluginId && e.bundleHash === bundleHash);
  if (idx < 0) return;
  file.entries.splice(idx, 1);
  await flushToDisk();
  await deleteApprovalBundle(pluginId, bundleHash);
}

export class ApprovalLimitError extends Error {}
