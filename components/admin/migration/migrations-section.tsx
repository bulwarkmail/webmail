'use client';

import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Plus } from '@/components/icons';
import { AdminList } from '@/components/admin/list';
import { Badge } from '@/components/admin/badge';
import { EmptyState } from '@/components/admin/empty-state';
import { ConfigNote, inputClass } from '@/components/admin/config-items';
import { useAdminFeedback } from '@/components/admin/feedback';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { withBasePath } from '@/lib/browser-navigation';
import type { CopyWhat } from '@/lib/migration/types';
import { cn } from '@/lib/utils';
import { MigrationAccountsList } from './accounts-list';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  fieldHintClass,
  fieldLabelClass,
  formatDate,
  formatDateTime,
  messageProgress,
  postMigration,
  type CsvProblem,
  type PublicMigration,
  type PublicSource,
} from './shared';

export const NO_MASTER_NOTICE = 'Bulk migration needs the Stalwart master user. Set BULWARK_STALWART_MASTER_USER and BULWARK_STALWART_MASTER_PASSWORD.';
const PASS_NOTE = 'Copies what is new on the old server. Deleted messages and changed flags are not carried over.';
const REPORT_URL = '/api/admin/migration/report';

interface Props {
  masterConfigured: boolean;
  sources: PublicSource[];
  migrations: PublicMigration[];
  refreshKey: number;
  onChanged: () => Promise<void> | void;
}

type Pending = { kind: 'finish' | 'remove'; migration: PublicMigration };

export function MigrationsSection({ masterConfigured, sources, migrations, refreshKey, onChanged }: Props) {
  const setMessage = useAdminFeedback();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const sorted = [...migrations].sort((a, b) => b.createdAt - a.createdAt);

  async function act(action: 'pass' | 'cancel' | 'finish' | 'remove', migration: PublicMigration, accountKey?: string): Promise<void> {
    const result = await postMigration<{ queued?: number }>({ action, migrationId: migration.id, ...(accountKey ? { accountKey } : {}) });
    if (!result.ok) {
      setMessage({ type: 'error', text: result.error });
      return;
    }
    const text = action === 'pass'
      ? (result.data.queued ? `Copying new items: ${result.data.queued.toLocaleString()} ${result.data.queued === 1 ? 'account' : 'accounts'} queued.` : 'Nothing to queue: every account is already running.')
      : action === 'cancel' ? 'Cancelling. Running accounts stop after the current batch.'
        : action === 'finish' ? 'Migration finished. Its stored passwords are deleted.'
          : 'Migration removed.';
    setMessage({ type: 'success', text });
    await onChanged();
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <SettingsSection
      id="migrations"
      title="Migrations"
      description="Bulk migrations from a list of accounts, and the ones users started themselves in Settings."
    >
      {!masterConfigured && <ConfigNote tone="warning">{NO_MASTER_NOTICE}</ConfigNote>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {migrations.length > 0 && (
          <a href={withBasePath(REPORT_URL)} download className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <Download className="h-3.5 w-3.5" />
            Download all reports
          </a>
        )}
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!masterConfigured || sources.length === 0}
          title={masterConfigured && sources.length === 0 ? 'Add a source server first' : undefined}
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          New migration
        </Button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="No migrations yet" hint={masterConfigured ? 'Start one with New migration, or let users move their own mailbox from a source server.' : undefined} />
      ) : (
        <AdminList>
          {sorted.map((m) => (
            <MigrationRow
              key={m.id}
              migration={m}
              open={expanded.has(m.id)}
              refreshKey={refreshKey}
              onToggle={() => toggle(m.id)}
              onAction={(action, key) => void act(action, m, key)}
              onAsk={(kind) => setPending({ kind, migration: m })}
            />
          ))}
        </AdminList>
      )}

      {creating && (
        <NewMigrationDialog
          sources={sources}
          onClose={() => setCreating(false)}
          onStarted={async (count) => {
            setCreating(false);
            setMessage({ type: 'success', text: `Migration started for ${count.toLocaleString()} ${count === 1 ? 'account' : 'accounts'}.` });
            await onChanged();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => { const p = pending; setPending(null); if (p) void act(p.kind, p.migration); }}
        title={pending?.kind === 'finish' ? 'Finish this migration?' : 'Remove this migration?'}
        message={pending?.kind === 'finish'
          ? 'This ends the migration for good: running accounts stop and its stored passwords are deleted, so no more new items can be copied. The report stays.'
          : 'Running accounts stop, and the migration and its report are removed. What was already copied stays in the mailboxes.'}
        confirmText={pending?.kind === 'finish' ? 'Finish migration' : 'Remove'}
        variant="destructive"
      />
    </SettingsSection>
  );
}

interface RowProps {
  migration: PublicMigration;
  open: boolean;
  refreshKey: number;
  onToggle: () => void;
  onAction: (action: 'pass' | 'cancel', accountKey?: string) => void;
  onAsk: (kind: 'finish' | 'remove') => void;
}

function MigrationRow({ migration: m, open, refreshKey, onToggle, onAction, onAsk }: RowProps) {
  const finished = !!m.finishedAt;
  const canCopy = !finished && !m.credentialsForgottenAt;
  const counts = STATUS_ORDER.filter((s) => m.statusCounts[s]).map((s) => `${m.statusCounts[s]!.toLocaleString()} ${STATUS_LABELS[s]}`);
  return (
    <div data-testid="migration-row" className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-all text-sm font-medium text-foreground">{m.sourceName}</span>
        {m.kind === 'self' && <Badge tone="info">Started by the user</Badge>}
        {m.kind === 'self' && <span className="min-w-0 truncate text-xs text-muted-foreground" title={m.startedBy}>{m.startedBy}</span>}
        {finished ? <Badge tone="muted">Finished</Badge> : m.running ? <Badge tone="accent">Running</Badge> : null}
      </div>
      {m.customHosts && m.customHosts.length > 0 && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={m.customHosts.join(', ')}>{m.customHosts.join(', ')}</p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>Started {formatDate(m.createdAt)}</span>
        <span>{m.accountCount.toLocaleString()} {m.accountCount === 1 ? 'account' : 'accounts'}</span>
        {counts.length > 0 && <span>{counts.join(', ')}</span>}
        {m.progress.messagesTotal > 0 && <span>{messageProgress(m.progress.messagesDone, m.progress.messagesTotal)}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {finished && <span>Finished {formatDateTime(m.finishedAt!)}</span>}
        {m.credentialsForgottenAt ? <span>Stored passwords deleted</span> : m.forgetAt ? <span>Stored passwords are deleted on {formatDate(m.forgetAt)}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!finished && (
          <Button type="button" variant="outline" size="sm" disabled={!canCopy} onClick={() => onAction('pass')}>Copy new items</Button>
        )}
        {m.running && <Button type="button" variant="outline" size="sm" onClick={() => onAction('cancel')}>Cancel</Button>}
        {!finished && <Button type="button" variant="outline" size="sm" onClick={() => onAsk('finish')}>Finish migration</Button>}
        <Button type="button" variant="ghost" size="sm" className="hover:text-destructive" onClick={() => onAsk('remove')}>Remove</Button>
        <a
          href={withBasePath(`${REPORT_URL}?migration=${encodeURIComponent(m.id)}`)}
          download
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
          Download report
        </a>
      </div>
      {!finished && <p className={cn(fieldHintClass, 'mt-0')}>{PASS_NOTE}</p>}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? 'Hide accounts' : 'Show accounts'}
      </button>
      {open && (
        <MigrationAccountsList
          migrationId={m.id}
          refreshKey={refreshKey}
          canCopy={canCopy}
          onAction={(action, key) => onAction(action, key)}
        />
      )}
    </div>
  );
}

const WHAT_LABELS: { key: keyof CopyWhat; label: string }[] = [
  { key: 'mail', label: 'Mail' },
  { key: 'calendars', label: 'Calendars' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'filters', label: 'Filters' },
];

interface NewMigrationDialogProps {
  sources: PublicSource[];
  onClose: () => void;
  onStarted: (accounts: number) => Promise<void> | void;
}

function NewMigrationDialog({ sources, onClose, onStarted }: NewMigrationDialogProps) {
  const idBase = useId();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [what, setWhat] = useState<CopyWhat>({ mail: true, calendars: true, contacts: true, filters: true });
  const [busy, setBusy] = useState<'check' | 'start' | null>(null);
  /** The outcome of the last check or start, for the list as it stands. */
  const [checked, setChecked] = useState<{ rows?: number; problems: CsvProblem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function changeList(next: string) {
    setCsv(next);
    setChecked(null);
    setError(null);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    try {
      changeList(await file.text());
    } catch {
      setError('Could not read the file.');
    }
  }

  async function check() {
    setBusy('check');
    setError(null);
    try {
      const result = await postMigration<{ rows: number; problems: CsvProblem[] }>({ action: 'validate-csv', sourceId, csv });
      if (result.ok) setChecked({ rows: result.data.rows, problems: result.data.problems ?? [] });
      else setError(result.error);
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy('start');
    setError(null);
    try {
      const result = await postMigration<{ migration: PublicMigration }>({ action: 'start-bulk', sourceId, csv, what });
      if (result.ok) {
        await onStarted(result.data.migration.accountCount);
        return;
      }
      if (result.problems) setChecked({ problems: result.problems });
      else setError(result.error);
    } finally {
      setBusy(null);
    }
  }

  const source = sources.find((s) => s.id === sourceId);
  const problems = checked?.problems ?? [];
  const nothingChosen = !Object.values(what).some(Boolean);
  const fieldClass = cn(inputClass, 'w-full min-w-0');

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="New migration"
      size="full-on-phone"
      dirty={csv.trim() !== ''}
      testId="migration-new-dialog"
      footer={(
        <>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="outline" className="gap-2" disabled={busy !== null || !csv.trim() || !sourceId} onClick={() => void check()}>
            {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" />}
            Check
          </Button>
          <Button type="button" className="gap-2" disabled={busy !== null || !csv.trim() || !sourceId || nothingChosen || problems.length > 0} onClick={() => void start()}>
            {busy === 'start' && <Loader2 className="h-4 w-4 animate-spin" />}
            Start
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor={`${idBase}-source`} className={fieldLabelClass}>Source server</label>
          <select id={`${idBase}-source`} value={sourceId} onChange={(e) => { setSourceId(e.target.value); setChecked(null); }} className={cn(fieldClass, 'pe-8 cursor-pointer')}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {source && !source.adminLogin?.passwordSaved && (
            <p className={fieldHintClass}>This server has no admin login: every row needs its source_password.</p>
          )}
        </div>

        <div>
          <label htmlFor={`${idBase}-csv`} className={fieldLabelClass}>Accounts (CSV)</label>
          <textarea
            id={`${idBase}-csv`}
            value={csv}
            onChange={(e) => changeList(e.target.value)}
            rows={8}
            placeholder={'source_user,target_account,source_password\nalice,alice@example.com,\nbob,bob@example.com,secret'}
            spellCheck={false}
            className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-hidden"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <label htmlFor={`${idBase}-file`} className="text-xs text-muted-foreground">Or upload a .csv file:</label>
            <input
              id={`${idBase}-file`}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ''; }}
              className="min-w-0 max-w-full text-xs text-muted-foreground file:me-2 file:rounded-md file:border file:border-input file:bg-background file:px-2 file:py-1 file:text-xs file:text-foreground"
            />
          </div>
          <p className={fieldHintClass}>
            The first line is the header <code className="font-mono">source_user,target_account,source_password</code>. source_password may be empty when the source server has an admin login: that row is then copied with the admin login, and its calendars and contacts are skipped.
          </p>
        </div>

        <fieldset>
          <legend className={fieldLabelClass}>Copy</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {WHAT_LABELS.map(({ key, label }) => (
              <label key={key} className="inline-flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="rounded border-input"
                  checked={what[key]}
                  onChange={(e) => setWhat({ ...what, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          {nothingChosen && <p className="mt-1 text-xs text-destructive">Choose at least one thing to copy.</p>}
        </fieldset>

        {error && <p role="alert" className="text-xs text-destructive wrap-anywhere">{error}</p>}
        {problems.length > 0 && (
          <div role="alert" data-testid="migration-csv-problems" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive">
              Nothing was started. Fix {problems.length === 1 ? 'this row' : `these ${problems.length.toLocaleString()} rows`} and check again:
            </p>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-foreground">
              {problems.map((p) => <li key={`${p.row}-${p.reason}`} className="wrap-anywhere">Row {p.row}: {p.reason}</li>)}
            </ul>
          </div>
        )}
        {checked && problems.length === 0 && checked.rows !== undefined && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            {checked.rows.toLocaleString()} {checked.rows === 1 ? 'account is' : 'accounts are'} ready to start.
          </p>
        )}
      </div>
    </Dialog>
  );
}
