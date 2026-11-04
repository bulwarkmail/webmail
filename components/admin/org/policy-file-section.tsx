'use client';

import { useRef, useState } from 'react';
import { Download, Loader2, Upload } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/browser-navigation';
import type { KeyChanges, PolicyChangeSummary } from '@/lib/admin/policy-diff';
import type { OrgPolicyDraft } from './use-org-policy-draft';

/** "contrast, fontSize and 3 more": which keys, so an admin can tell what the file does. */
function names(keys: string[]): string {
  const shown = keys.slice(0, 5).join(', ');
  return keys.length > 5 ? `${shown} and ${keys.length - 5} more` : shown;
}

function describe(label: string, changes: KeyChanges): string | null {
  const parts = [
    changes.added.length ? `${changes.added.length} added (${names(changes.added)})` : null,
    changes.changed.length ? `${changes.changed.length} changed (${names(changes.changed)})` : null,
    changes.removed.length ? `${changes.removed.length} removed (${names(changes.removed)})` : null,
  ].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(', ')}` : null;
}

function summaryLines(summary: PolicyChangeSummary): string[] {
  return [
    describe('Domains and groups', summary.scopes),
    describe('Organisation settings', summary.organisation),
    describe('Locked, limited and hidden settings', summary.restrictions),
    describe('Features', summary.features),
    describe('Defaults', summary.defaults),
    summary.other.length ? `Also: ${summary.other.join(', ')}` : null,
  ].filter((line): line is string => !!line);
}

/**
 * Export and import of the whole user policy as policy.json, so the policy
 * can live in git, move to another instance or go next to a Lite build.
 * An import shows what it changes before it replaces anything.
 */
export function PolicyFileSection({ draft }: { draft: OrgPolicyDraft }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ name: string; text: string; summary: PolicyChangeSummary } | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportFile() {
    const res = await apiFetch('/api/admin/policy/file');
    if (!res.ok) {
      draft.setMessage({ type: 'error', text: 'Could not export the policy' });
      return;
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'bulwark-policy.json';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function pick(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const res = await apiFetch('/api/admin/policy/file?preview=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        draft.setMessage({ type: 'error', text: data.error || 'Could not read the file' });
        return;
      }
      setPending({ name: file.name, text, summary: data.summary });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function apply() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/policy/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pending.text });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        draft.setMessage({ type: 'error', text: data.error || 'Could not import the file' });
        return;
      }
      setPending(null);
      await draft.reload();
      draft.setMessage({ type: 'success', text: `Imported ${pending.name}.` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      id="policy-file"
      title="Policy file"
      description="Everything on the pages under Users is one file, policy.json. Export it to keep it in git or copy it to another Bulwark or a Lite build; importing replaces the current policy."
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void exportFile()}>
          <Download className="h-3.5 w-3.5" /> Export policy.json
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={busy || draft.dirty}
          onClick={() => input.current?.click()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import a file
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Policy file to import"
          onChange={(e) => { const file = e.target.files?.[0]; if (file) void pick(file); }}
        />
      </div>
      {draft.dirty && <p className="text-xs text-muted-foreground">Save or discard your changes first.</p>}
      {pending && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2" data-testid="policy-import-preview">
          <p className="text-sm font-medium text-foreground">Importing {pending.name}</p>
          {pending.summary.unchanged ? (
            <p className="text-sm text-muted-foreground">It matches the current policy; nothing would change.</p>
          ) : (
            <ul className="list-disc ps-5 text-sm text-foreground">
              {summaryLines(pending.summary).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" disabled={busy || pending.summary.unchanged} onClick={() => void apply()}>
              Replace the current policy
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
