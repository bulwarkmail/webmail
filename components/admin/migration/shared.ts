import type { PublicAccount, PublicMigration, TestOutcome } from '@/lib/migration/service';
import type { PublicSource } from '@/lib/migration/types';
import { RUNNING_STATUSES, type AccountStatus, type MigrationOptions } from '@/lib/migration/types';
import { apiFetch } from '@/lib/browser-navigation';

/** Admin > Mailbox migration (#1760): what the page and its sections share. */

export type { PublicAccount, PublicMigration, PublicSource, TestOutcome };

export interface MigrationOverview {
  masterConfigured: boolean;
  sources: PublicSource[];
  options: MigrationOptions;
  migrations: PublicMigration[];
}

export interface CsvProblem {
  row: number;
  reason: string;
}

export const MIGRATION_API = '/api/admin/migration';

export type PostResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code?: string; problems?: CsvProblem[] };

/** One POST action; an error comes back as its text (`{ error, code? }`, or the bad CSV rows). */
export async function postMigration<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<PostResult<T>> {
  try {
    const r = await apiFetch(MIGRATION_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return { ok: true, data: data as T };
    return {
      ok: false,
      status: r.status,
      error: typeof data.error === 'string' ? data.error : `Request failed (HTTP ${r.status})`,
      ...(typeof data.code === 'string' ? { code: data.code } : {}),
      ...(Array.isArray(data.problems) ? { problems: data.problems as CsvProblem[] } : {}),
    };
  } catch {
    return { ok: false, status: 0, error: 'The server could not be reached.' };
  }
}

export const STATUS_LABELS: Record<AccountStatus, string> = {
  queued: 'Queued',
  mail: 'Copying mail',
  contacts: 'Copying contacts',
  calendars: 'Copying calendars',
  filters: 'Copying filters',
  paused: 'Paused',
  done: 'Done',
  done_with_problems: 'Done with problems',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const STATUS_ORDER = Object.keys(STATUS_LABELS) as AccountStatus[];

export function statusTone(status: AccountStatus): 'success' | 'warning' | 'danger' | 'info' | 'muted' {
  switch (status) {
    case 'done': return 'success';
    case 'done_with_problems':
    case 'paused': return 'warning';
    case 'failed': return 'danger';
    case 'cancelled': return 'muted';
    default: return 'info';
  }
}

export function isRunningStatus(status: AccountStatus): boolean {
  return RUNNING_STATUSES.includes(status);
}

/** "1,234 of 5,678 messages". */
export function messageProgress(done: number, total: number): string {
  return `${done.toLocaleString()} of ${total.toLocaleString()} messages`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const fieldLabelClass = 'block text-[0.6875rem] font-medium text-muted-foreground mb-1';
export const fieldHintClass = 'mt-1 text-[0.6875rem] text-muted-foreground';
