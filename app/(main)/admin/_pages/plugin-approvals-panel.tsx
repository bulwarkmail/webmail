'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Code, Loader2, X } from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import { HIGH_RISK_PERMISSIONS } from '@/lib/plugin-sandbox/permission-text';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useAdminShell } from '@/components/admin/shell-context';
import { Badge, type BadgeTone } from '@/components/admin/badge';

interface ApprovalEntry {
  pluginId: string;
  bundleHash: string;
  status: 'pending' | 'approved' | 'denied';
  manifest: {
    name?: string;
    version?: string;
    author?: string;
    description?: string;
    permissions?: string[];
    httpOrigins?: string[];
    apiPostPaths?: string[];
  };
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
}

interface SourceView {
  entry: ApprovalEntry;
  code?: string;
  warnings?: string[];
  error?: string;
}

const STATUS_TONE: Record<ApprovalEntry['status'], BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  denied: 'muted',
};

/**
 * Plugins users installed themselves and asked to have approved. The admin
 * decides on the package the user uploaded: its manifest and code are read
 * on the server, and the approval is pinned to that exact package. Shown
 * only while there is something to decide or to look back on.
 */
export function PluginApprovalsPanel() {
  const [entries, setEntries] = useState<ApprovalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState<SourceView | null>(null);
  const [showPast, setShowPast] = useState(false);
  const refreshBadges = useAdminShell()?.refreshBadges;

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/plugin-approvals');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { entries: ApprovalEntry[] };
      setEntries([...data.entries].sort((a, b) =>
        Number(b.status === 'pending') - Number(a.status === 'pending') || b.requestedAt.localeCompare(a.requestedAt)));
      setError(null);
    } catch (e) {
      setError(`Could not load approval requests (${(e as Error).message})`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(entry: ApprovalEntry, decision: 'approved' | 'denied' | 'revoke') {
    const key = `${entry.pluginId}:${entry.bundleHash}`;
    setBusy(key);
    try {
      const res = decision === 'revoke'
        ? await apiFetch(`/api/admin/plugin-approvals?pluginId=${encodeURIComponent(entry.pluginId)}&bundleHash=${encodeURIComponent(entry.bundleHash)}`, { method: 'DELETE' })
        : await apiFetch('/api/admin/plugin-approvals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pluginId: entry.pluginId, bundleHash: entry.bundleHash, decision }),
          });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      refreshBadges?.();
    } catch (e) {
      setError(`Could not save the decision (${(e as Error).message})`);
    } finally {
      setBusy(null);
    }
  }

  async function viewSource(entry: ApprovalEntry) {
    setSource({ entry });
    try {
      const res = await apiFetch(`/api/admin/plugin-approvals/source?pluginId=${encodeURIComponent(entry.pluginId)}&bundleHash=${encodeURIComponent(entry.bundleHash)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSource({ entry, code: data.code, warnings: data.warnings });
    } catch (e) {
      setSource({ entry, error: (e as Error).message });
    }
  }

  if (!error && (entries === null || entries.length === 0)) return null;

  const pending = entries?.filter((e) => e.status === 'pending') ?? [];
  const past = entries?.filter((e) => e.status !== 'pending') ?? [];

  const renderEntry = (entry: ApprovalEntry) => {
    const key = `${entry.pluginId}:${entry.bundleHash}`;
    const perms = entry.manifest.permissions ?? [];
    const sendsTo = [...(entry.manifest.httpOrigins ?? []), ...(entry.manifest.apiPostPaths ?? [])];
    return (
      <div key={key} className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{entry.manifest.name ?? entry.pluginId}</span>
          <span className="text-xs text-muted-foreground">v{entry.manifest.version}</span>
          <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
        </div>
        {entry.manifest.description && <p className="text-xs text-muted-foreground">{entry.manifest.description}</p>}
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <code className="font-mono">{entry.pluginId}</code> &middot; by {entry.manifest.author ?? 'unknown'} &middot; requested by {entry.requestedBy} on {new Date(entry.requestedAt).toLocaleString()}
        </div>
        {perms.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {perms.map((p) => (
              <Badge key={p} tone={HIGH_RISK_PERMISSIONS.has(p) ? 'warning' : 'muted'} className="font-mono">{p}</Badge>
            ))}
          </div>
        )}
        {sendsTo.length > 0 && (
          <div className="break-all text-xs text-muted-foreground">Can send data to: {sendsTo.join(', ')}</div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => viewSource(entry)}>
            <Code className="h-3.5 w-3.5" /> View code
          </Button>
          {entry.status !== 'approved' && (
            <Button type="button" size="sm" className="h-8 gap-1.5 text-xs" disabled={busy === key} onClick={() => decide(entry, 'approved')}>
              <Check className="h-3.5 w-3.5" /> Approve
            </Button>
          )}
          {entry.status !== 'denied' && (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={busy === key} onClick={() => decide(entry, 'denied')}>
              <X className="h-3.5 w-3.5" /> Deny
            </Button>
          )}
          {entry.status !== 'pending' && (
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive" disabled={busy === key} onClick={() => decide(entry, 'revoke')}>
              Forget decision
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <SettingsSection
      id="approvals"
      title={pending.length > 0 ? `Approval requests (${pending.length})` : 'Approval requests'}
      description="Plugins users installed themselves. Read the code before you approve: an approved plugin runs in that user's mail."
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {pending.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-amber-300/60 dark:border-amber-700/60">
          {pending.map(renderEntry)}
        </div>
      )}
      {past.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={showPast}
          >
            {showPast ? 'Hide' : 'Show'} {past.length} past decision{past.length === 1 ? '' : 's'}
          </button>
          {showPast && (
            <div className="mt-2 divide-y divide-border rounded-lg border border-border">
              {past.map(renderEntry)}
            </div>
          )}
        </div>
      )}

      {/* The shared dialog: focus moved in and given back, Tab kept inside,
          Escape closes, and the title names the plugin. */}
      <Dialog
        isOpen={!!source}
        onClose={() => setSource(null)}
        title={source ? `Code of ${source.entry.manifest.name ?? source.entry.pluginId} v${source.entry.manifest.version}` : ''}
        size="lg"
        className="max-w-4xl"
        bodyClassName="flex flex-col"
      >
        {source?.warnings && source.warnings.length > 0 && (
          <div className="mb-2 flex items-start gap-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-warning" aria-hidden="true" /> {source.warnings.join('; ')}
          </div>
        )}
        {/* Focusable, so the keyboard can scroll the code. */}
        <pre tabIndex={0} aria-label="Plugin code" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border p-4 font-mono text-[0.6875rem] leading-relaxed">
          {source?.error ?? source?.code ?? (<span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading</span>)}
        </pre>
      </Dialog>
    </SettingsSection>
  );
}
