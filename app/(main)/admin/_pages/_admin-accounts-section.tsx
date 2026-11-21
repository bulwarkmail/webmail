'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from '@/components/icons';
import type { AdminAccountEntry } from '@/lib/admin/admin-accounts';
import { Button } from '@/components/ui/button';
import { inputClass, RevertButton, SourceBadge } from '@/components/admin/config-items';
import { cn } from '@/lib/utils';

export interface AdminAccountServerOption {
  url: string;
  label: string;
}

interface Props {
  value: AdminAccountEntry[];
  source?: string;
  /** The configured mail servers: the global JMAP server URL and the server list. */
  servers: AdminAccountServerOption[];
  /** The `stalwartAdminAccess` setting the entries follow. */
  mode: string;
  onChange: (next: AdminAccountEntry[]) => void;
  onRevert: () => void;
}

// The stored URL is the configured one as written, so this only has to
// forgive a trailing slash or a host in other case.
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function toDrafts(value: AdminAccountEntry[]): AdminAccountEntry[] {
  return value.map((e) => ({ serverUrl: e.serverUrl ?? '', account: e.account ?? '' }));
}

export function AdminAccountsSection({ value, source, servers, mode, onChange, onRevert }: Props) {
  const [drafts, setDrafts] = useState<AdminAccountEntry[]>(() => toDrafts(value));
  const lastEmittedRef = useRef(value);

  // Reset only when the value changes from outside (a save, a revert, a
  // discard), not when an edit lands back on the saved value, so a row the
  // admin is still filling in stays.
  useEffect(() => {
    if (JSON.stringify(value) === JSON.stringify(lastEmittedRef.current)) return;
    lastEmittedRef.current = value;
    setDrafts(toDrafts(value));
  }, [value]);

  function commit(next: AdminAccountEntry[]) {
    setDrafts(next);
    // A row without an account name isn't saved.
    const entries = next
      .map((d) => ({ serverUrl: d.serverUrl, account: d.account.trim() }))
      .filter((d) => d.account.length > 0);
    lastEmittedRef.current = entries;
    onChange(entries);
  }

  function update(idx: number, patch: Partial<AdminAccountEntry>) {
    commit(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function remove(idx: number) {
    commit(drafts.filter((_, i) => i !== idx));
  }

  function add() {
    // Counts once it has an account name.
    setDrafts((prev) => [...prev, { serverUrl: servers.length === 1 ? servers[0].url : '', account: '' }]);
  }

  const noServers = servers.length === 0;

  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:pe-4">
          <span className="text-sm font-medium text-foreground">Additional admin accounts</span>
          <p className="text-xs text-muted-foreground mt-1">
            These mail accounts get the same access as Stalwart admin accounts, following the setting above, without needing an admin role in Stalwart. Each entry applies to one mail server only. Enter the account name the user signs in with.
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SourceBadge source={source} />
          {source === 'admin' && <RevertButton onClick={onRevert} />}
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={add} disabled={noServers}>
            <Plus className="w-3.5 h-3.5" />
            Add account
          </Button>
        </div>
      </div>

      {noServers && (
        <p className="text-xs text-muted-foreground">Configure a mail server first (Settings &gt; JMAP servers).</p>
      )}

      {drafts.length === 0 && (
        <div className="text-xs text-muted-foreground italic">No additional admin accounts.</div>
      )}

      {drafts.map((d, i) => {
        const server = servers.find((s) => sameUrl(s.url, d.serverUrl));
        const stale = !server && d.serverUrl.length > 0;
        return (
          <div key={i} data-testid="admin-account-row" className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={server?.url ?? d.serverUrl}
                onChange={(e) => update(i, { serverUrl: e.target.value })}
                aria-label="Mail server"
                className={cn(inputClass, 'w-full min-w-0 pe-8 cursor-pointer sm:w-64', stale && 'border-amber-500 dark:border-amber-600')}
              >
                {!server && (
                  <option value={d.serverUrl} disabled>{d.serverUrl || 'Choose a server'}</option>
                )}
                {servers.map((s) => (
                  <option key={s.url} value={s.url}>{s.label}</option>
                ))}
              </select>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="text"
                  value={d.account}
                  onChange={(e) => update(i, { account: e.target.value })}
                  placeholder="user@example.com"
                  aria-label="Account"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={256}
                  className={cn(inputClass, 'w-full min-w-0')}
                />
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive transition-colors"
                  title="Remove account"
                  aria-label="Remove account"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            {stale && (
              <p className="text-[0.6875rem] text-amber-700 dark:text-amber-400">This server is no longer configured; the entry is ignored.</p>
            )}
          </div>
        );
      })}

      {mode === 'off' && (
        <p className="text-xs text-muted-foreground">Ignored while Stalwart admin accounts is set to Off.</p>
      )}
    </div>
  );
}
