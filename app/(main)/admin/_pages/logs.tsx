'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, ScrollText } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Badge } from '@/components/admin/badge';
import { EmptyState } from '@/components/admin/empty-state';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass } from '@/components/admin/config-items';
import type { AuditEntry } from '@/lib/admin/types';
import { formatAuditDetail } from '@/lib/admin/audit-format';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { apiFetch } from '@/lib/browser-navigation';
import { cn } from '@/lib/utils';

const PAGE = adminPageDef('logs');

export function LogsPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const setMessage = useAdminFeedback();
  const limit = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (actionFilter) params.set('action', actionFilter);

    try {
      const res = await apiFetch(`/api/admin/audit?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    } catch {
      setLoadFailed(true);
      setMessage({ type: 'error', text: 'Could not load the audit log' });
    }
    setLoading(false);
  }, [page, actionFilter, setMessage]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const initialLoading = loading && entries.length === 0;

  return (
    <div>
      <AdminPageHeader
        title={PAGE.label}
        description={<>{PAGE.description} &middot; {total} total entries</>}
        actions={(
          <>
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              aria-label="Filter by action"
              className={cn(inputClass, 'pe-8 cursor-pointer')}
            >
              <option value="">All actions</option>
              <option value="admin.login">Login</option>
              <option value="admin.logout">Logout</option>
              <option value="admin.login_failed">Login Failed</option>
              <option value="admin.login_blocked">Login Blocked</option>
              <option value="admin.change-password">Password Change</option>
              <option value="config.update">Config Update</option>
              <option value="config.revert">Config Revert</option>
              <option value="policy.update">Policy Update</option>
              <option value="plugin.install">Plugin Install</option>
              <option value="plugin.update">Plugin Update</option>
              <option value="plugin.rollback">Plugin Rollback</option>
              <option value="plugin.delete">Plugin Removal</option>
              <option value="theme.install">Theme Install</option>
              <option value="theme.update">Theme Update</option>
              <option value="theme.rollback">Theme Rollback</option>
              <option value="theme.delete">Theme Removal</option>
            </select>
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={fetchLogs} disabled={loading}>
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin [animation-direction:reverse]')} />
              Refresh
            </Button>
          </>
        )}
      />

      {initialLoading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={loadFailed ? 'Could not load the audit log' : 'No entries found'}
          hint={loadFailed ? undefined : actionFilter ? 'Nothing matches this action filter.' : 'Admin actions show up here as they happen.'}
        />
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {entries.map((entry, i) => (
              <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge className="font-mono text-xs truncate">{entry.action}</Badge>
                  <span className="text-[0.6875rem] text-muted-foreground whitespace-nowrap">
                    {new Date(entry.ts).toLocaleString()}
                  </span>
                </div>
                <div className="text-xs text-foreground break-words">
                  {formatAuditDetail(entry.detail) || '-'}
                </div>
                <div className="text-[0.6875rem] text-muted-foreground font-mono">
                  {entry.ip}
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:block rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-start px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Time</th>
                  <th className="text-start px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Action</th>
                  <th className="text-start px-4 py-2 text-xs font-medium text-muted-foreground">Details</th>
                  <th className="text-start px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry, i) => (
                  <tr key={i} className="hover:bg-muted/20">
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(entry.ts).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">
                      <Badge className="font-mono text-xs">{entry.action}</Badge>
                    </td>
                    <td className="w-full max-w-0 truncate px-4 py-2 text-xs text-foreground" title={formatAuditDetail(entry.detail)}>
                      {formatAuditDetail(entry.detail) || '-'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                      {/* A fixed width, so a full IPv6 address wraps instead of pushing the table wide. */}
                      <div className="w-28 break-all">{entry.ip}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
