'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AuditEntry } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';

export default function AdminLogsPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const limit = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (actionFilter) params.set('action', actionFilter);

    const res = await apiFetch(`/api/admin/audit?${params}`);
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [page, actionFilter]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-1">{total} total entries</p>
        </div>
        <button
          onClick={fetchLogs}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground hover:bg-accent transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className="h-8 w-full sm:w-auto rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        </select>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-2">
        {loading && entries.length === 0 ? (
          <div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">No entries found</div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground truncate">
                  {entry.action}
                </span>
                <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                  {new Date(entry.ts).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-foreground break-words">
                {formatDetail(entry.detail)}
              </div>
              <div className="text-[11px] text-muted-foreground font-mono">
                {entry.ip}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground whitespace-nowrap">Time</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground whitespace-nowrap">Action</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Details</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground whitespace-nowrap">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No entries found</td>
              </tr>
            ) : (
              entries.map((entry, i) => (
                <tr key={i} className="hover:bg-muted/20">
                  <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(entry.ts).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-foreground max-w-xs truncate">
                    {formatDetail(entry.detail)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                    {entry.ip}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-8 px-3 rounded-md border border-input bg-background text-sm disabled:opacity-50 hover:bg-accent transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-8 px-3 rounded-md border border-input bg-background text-sm disabled:opacity-50 hover:bg-accent transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDetail(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return '-';
  if (detail.reason) return String(detail.reason);
  if (detail.key) return `${detail.key}: ${JSON.stringify(detail.old)} → ${JSON.stringify(detail.new)}`;
  if (detail.changes && Array.isArray(detail.changes)) {
    return detail.changes.map((c: Record<string, unknown>) => `${c.key}`).join(', ');
  }
  if (detail.restrictionCount !== undefined) return `${detail.restrictionCount} restriction(s)`;
  return JSON.stringify(detail).slice(0, 100);
}
