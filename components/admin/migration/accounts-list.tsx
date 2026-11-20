'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search } from '@/components/icons';
import { Badge } from '@/components/admin/badge';
import { inputClass } from '@/components/admin/config-items';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/browser-navigation';
import type { ReportKind } from '@/lib/migration/types';
import { cn } from '@/lib/utils';
import {
  MIGRATION_API,
  STATUS_LABELS,
  STATUS_ORDER,
  formatTime,
  isRunningStatus,
  messageProgress,
  statusTone,
  type PublicAccount,
} from './shared';

export const ACCOUNTS_PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;

const REPORT_KINDS: { kind: ReportKind; label: string }[] = [
  { kind: 'messages', label: 'Messages' },
  { kind: 'folders', label: 'Folders' },
  { kind: 'contacts', label: 'Contacts' },
  { kind: 'events', label: 'Events' },
  { kind: 'scripts', label: 'Filter scripts' },
];

const PHASE_LABELS: Record<string, string> = { mail: 'Mail', contacts: 'Contacts', calendars: 'Calendars', filters: 'Filters' };

interface Props {
  migrationId: string;
  /** Changes on every page refresh, so the open list follows. */
  refreshKey: number;
  /** New passes can still run (not finished, passwords kept). */
  canCopy: boolean;
  onAction: (action: 'pass' | 'cancel', accountKey: string) => void;
}

/** One migration's accounts, a page at a time from the server: fine for a thousand of them. */
export function MigrationAccountsList({ migrationId, refreshKey, canCopy, onAction }: Props) {
  const idBase = useId();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; accounts: PublicAccount[] } | null>(null);
  const [error, setError] = useState(false);

  // Typing settles before the list asks again.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ migration: migrationId, offset: String(offset), limit: String(ACCOUNTS_PAGE_SIZE) });
    if (query) params.set('q', query);
    if (status !== 'all') params.set('status', status);
    void (async () => {
      try {
        const r = await apiFetch(`${MIGRATION_API}?${params.toString()}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const next = (await r.json()) as { total: number; accounts: PublicAccount[] };
        if (live) { setData(next); setError(false); }
      } catch {
        if (live) setError(true);
      }
    })();
    return () => { live = false; };
  }, [migrationId, query, status, offset, refreshKey]);

  const total = data?.total ?? 0;

  return (
    <div className="space-y-3" data-testid="migration-accounts">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id={`${idBase}-search`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search source user or target"
            aria-label="Search accounts"
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass, 'w-full ps-8')}
          />
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          aria-label="Status"
          className={cn(inputClass, 'pe-8 cursor-pointer')}
        >
          <option value="all">All</option>
          <option value="running">Running</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      {error && <p className="text-xs text-destructive">Could not load the accounts.</p>}
      {!data && !error && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading accounts</p>
      )}
      {data && data.accounts.length === 0 && <p className="text-xs italic text-muted-foreground">No accounts match.</p>}

      {data && data.accounts.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {data.accounts.map((a) => (
            <AccountRow key={a.key} account={a} canCopy={canCopy} onAction={onAction} />
          ))}
        </ul>
      )}

      {total > ACCOUNTS_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{(offset + 1).toLocaleString()} to {Math.min(offset + ACCOUNTS_PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ACCOUNTS_PAGE_SIZE))}>Previous</Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={offset + ACCOUNTS_PAGE_SIZE >= total} onClick={() => setOffset(offset + ACCOUNTS_PAGE_SIZE)}>Next</Button>
          </span>
        </div>
      )}
    </div>
  );
}

function AccountRow({ account: a, canCopy, onAction }: { account: PublicAccount; canCopy: boolean; onAction: Props['onAction'] }) {
  const [open, setOpen] = useState(false);
  const running = isRunningStatus(a.status);
  const report = a.report;
  return (
    <li data-testid="migration-account-row" className="space-y-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 text-sm text-foreground">
          <span className="min-w-0 truncate" title={a.sourceUser}>{a.sourceUser}</span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">&rarr;</span>
          <span className="sr-only">to</span>
          <span className="min-w-0 truncate" title={a.target}>{a.target}</span>
        </div>
        <Badge tone={statusTone(a.status)}>{STATUS_LABELS[a.status]}</Badge>
        <div className="flex shrink-0 items-center gap-1.5">
          {!running && canCopy && (
            <Button type="button" variant="outline" size="xs" className="text-xs" onClick={() => onAction('pass', a.key)}>Copy new items</Button>
          )}
          {running && (
            <Button type="button" variant="outline" size="xs" className="text-xs" onClick={() => onAction('cancel', a.key)}>Cancel</Button>
          )}
        </div>
      </div>
      {a.status === 'mail' && a.progress.messagesTotal > 0 && (
        <p className="text-xs text-muted-foreground">{messageProgress(a.progress.messagesDone, a.progress.messagesTotal)}</p>
      )}
      {a.status === 'paused' && a.pausedUntil && (
        <p className="text-xs text-muted-foreground">Paused by the server&apos;s upload limit until {formatTime(a.pausedUntil)}</p>
      )}
      {a.status === 'failed' && a.error && <p className="text-xs text-destructive wrap-anywhere">{a.error}</p>}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Details
      </button>
      {open && (
        <div className="space-y-2 ps-4" data-testid="migration-account-report">
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pe-4 text-start font-medium" scope="col"><span className="sr-only">What</span></th>
                  <th className="pe-4 text-end font-medium" scope="col">Copied</th>
                  <th className="pe-4 text-end font-medium" scope="col">Skipped</th>
                  <th className="text-end font-medium" scope="col">Failed</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {REPORT_KINDS.map(({ kind, label }) => {
                  const c = report.counts[kind];
                  return (
                    <tr key={kind}>
                      <th className="pe-4 text-start font-normal text-muted-foreground" scope="row">{label}</th>
                      <td className="pe-4 text-end tabular-nums">{c.copied.toLocaleString()}</td>
                      <td className="pe-4 text-end tabular-nums">{c.skipped.toLocaleString()}</td>
                      <td className={cn('text-end tabular-nums', c.failed > 0 && 'text-destructive')}>{c.failed.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.problems.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-foreground">Problems</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {report.problems.map((p, i) => (
                  <li key={i} className="wrap-anywhere">
                    <span className="text-foreground">{PHASE_LABELS[p.phase] ?? p.phase}</span>
                    {p.item && <> &middot; {p.item}</>}: {p.reason}
                  </li>
                ))}
              </ul>
              {report.problemCount > report.problems.length && (
                <p className="mt-1 text-xs text-muted-foreground">
                  And {(report.problemCount - report.problems.length).toLocaleString()} more not listed.
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No problems.</p>
          )}
        </div>
      )}
    </li>
  );
}
