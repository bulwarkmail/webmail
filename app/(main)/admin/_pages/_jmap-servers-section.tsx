'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, ChevronDown, ChevronRight } from '@/components/icons';
import type { JmapServerEntry } from '@/lib/admin/jmap-servers';
import { Button } from '@/components/ui/button';
import { inputClass, RevertButton, SourceBadge } from '@/components/admin/config-items';
import { ToggleSwitch } from '@/components/settings/settings-section';
import { cn } from '@/lib/utils';

interface Props {
  value: JmapServerEntry[];
  source?: string;
  onChange: (next: JmapServerEntry[]) => void;
  onRevert: () => void;
}

interface RowDraft {
  id: string;
  label: string;
  url: string;
  domains: string;
  oauthClientId: string;
  oauthIssuerUrl: string;
  oauthClientSecret: string;
  /** The server holds a secret the dashboard is not shown; an empty field keeps it. */
  hasClientSecret: boolean;
  oauthButtonLabel: string;
  oauthEndSessionUrl: string;
  oauthExpanded: boolean;
  /** Its superusers may open the admin dashboard without the admin password. */
  adminAccess: boolean;
}

function entryToDraft(e: JmapServerEntry): RowDraft {
  const hasClientSecret = !!(e.oauth?.hasClientSecret || e.oauth?.clientSecret);
  return {
    id: e.id,
    label: e.label,
    url: e.url,
    domains: (e.domains ?? []).join(', '),
    oauthClientId: e.oauth?.clientId ?? '',
    oauthIssuerUrl: e.oauth?.issuerUrl ?? '',
    oauthClientSecret: '',
    hasClientSecret,
    oauthButtonLabel: e.oauth?.buttonLabel ?? '',
    oauthEndSessionUrl: e.oauth?.endSessionUrl ?? '',
    oauthExpanded: !!(e.oauth && (e.oauth.clientId || e.oauth.issuerUrl || hasClientSecret || e.oauth.endSessionUrl)),
    adminAccess: e.adminAccess === true,
  };
}

function draftToEntry(d: RowDraft): JmapServerEntry | null {
  const id = d.id.trim();
  const url = d.url.trim().replace(/\/+$/, '');
  if (!id || !url) return null;
  const domains = d.domains
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const clientId = d.oauthClientId.trim();
  const issuerUrl = d.oauthIssuerUrl.trim().replace(/\/+$/, '');
  const clientSecret = d.oauthClientSecret;
  const buttonLabel = d.oauthButtonLabel.trim();
  const endSessionUrl = d.oauthEndSessionUrl.trim();
  // A typed secret replaces the stored one; an empty field keeps it (the
  // server fills it back in), and the flag keeps the block alive so the
  // server knows there is still an OAuth client here.
  const oauth = clientId || issuerUrl || clientSecret || endSessionUrl || d.hasClientSecret
    ? {
        ...(clientId ? { clientId } : {}),
        ...(issuerUrl ? { issuerUrl } : {}),
        ...(clientSecret ? { clientSecret } : d.hasClientSecret ? { hasClientSecret: true } : {}),
        ...(buttonLabel ? { buttonLabel } : {}),
        ...(endSessionUrl ? { endSessionUrl } : {}),
      }
    : undefined;
  return {
    id,
    label: d.label.trim() || id,
    url,
    ...(domains.length > 0 ? { domains } : {}),
    ...(oauth ? { oauth } : {}),
    ...(d.adminAccess ? { adminAccess: true } : {}),
  };
}

function emptyDraft(): RowDraft {
  return {
    id: '',
    label: '',
    url: '',
    domains: '',
    oauthClientId: '',
    oauthIssuerUrl: '',
    oauthClientSecret: '',
    hasClientSecret: false,
    oauthButtonLabel: '',
    oauthEndSessionUrl: '',
    oauthExpanded: false,
    adminAccess: false,
  };
}

const fieldLabelClass = 'block text-[0.6875rem] font-medium text-muted-foreground mb-1';
const fieldClass = cn(inputClass, 'w-full');

export function JmapServersSection({ value, source, onChange, onRevert }: Props) {
  const tAdminAccess = useTranslations('admin_access');
  const [drafts, setDrafts] = useState<RowDraft[]>(() => value.map(entryToDraft));
  // Ids that tie each row's labels to its fields.
  const idBase = useId();
  const labelFor = (row: number) => (key: string) => `${idBase}-${row}-${key}`;
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    setDrafts(value.map(entryToDraft))
  }, [value]);

  function commit(next: RowDraft[]) {
    setDrafts(next);
    const entries = next.map(draftToEntry).filter((e): e is JmapServerEntry => e !== null);
    lastEmittedRef.current = entries;
    onChange(entries);
  }

  function update(idx: number, patch: Partial<RowDraft>) {
    commit(drafts.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function remove(idx: number) {
    commit(drafts.filter((_, i) => i !== idx));
  }

  function add() {
    setDrafts((prev) => [...prev, emptyDraft()]);
    // Don't commit yet - new row needs id+url before it counts.
  }

  const ids = new Set<string>();
  const duplicateIdx = new Set<number>();
  drafts.forEach((d, i) => {
    const id = d.id.trim();
    if (!id) return;
    if (ids.has(id)) duplicateIdx.add(i);
    ids.add(id);
  });

  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:pe-4">
          <span className="text-sm font-medium text-foreground">Servers</span>
          <p className="text-xs text-muted-foreground mt-1">
            Each entry appears as an option on the login dropdown. Leave the list empty to fall back to the single <code className="text-[0.6875rem]">JMAP server URL</code> above.
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SourceBadge source={source} />
          {source === 'admin' && <RevertButton onClick={onRevert} />}
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={add}>
            <Plus className="w-3.5 h-3.5" />
            Add server
          </Button>
        </div>
      </div>

      {drafts.length === 0 && (
        <div className="text-xs text-muted-foreground italic">No servers configured.</div>
      )}

      {drafts.map((d, i) => {
        const isDuplicate = duplicateIdx.has(i);
        return (
          <div key={i} className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
              <div className="sm:col-span-3">
                <label htmlFor={labelFor(i)("id")} className={fieldLabelClass}>ID</label>
                <input
                  id={labelFor(i)("id")}
                  type="text"
                  value={d.id}
                  onChange={(e) => update(i, { id: e.target.value })}
                  placeholder="main"
                  className={cn(fieldClass, isDuplicate && 'border-destructive')}
                />
                {isDuplicate && <p className="text-[0.625rem] text-destructive mt-0.5">Duplicate id</p>}
              </div>
              <div className="sm:col-span-4">
                <label htmlFor={labelFor(i)("label")} className={fieldLabelClass}>Label</label>
                <input
                  id={labelFor(i)("label")}
                  type="text"
                  value={d.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="Main server"
                  className={fieldClass}
                />
              </div>
              <div className="sm:col-span-5">
                <label htmlFor={labelFor(i)("url")} className={fieldLabelClass}>JMAP URL</label>
                <div className="flex items-center gap-2">
                  <input
                    id={labelFor(i)("url")}
                    type="url"
                    value={d.url}
                    onChange={(e) => update(i, { url: e.target.value })}
                    placeholder="https://mail.example.com"
                    className={fieldClass}
                  />
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive transition-colors"
                    title="Remove server"
                    aria-label="Remove server"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label htmlFor={labelFor(i)("domains")} className={fieldLabelClass}>
                Email domains (comma-separated, used for auto-pick)
              </label>
              <input
                id={labelFor(i)("domains")}
                type="text"
                value={d.domains}
                onChange={(e) => update(i, { domains: e.target.value })}
                placeholder="example.com, example.org"
                className={fieldClass}
              />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-xs font-medium text-foreground">
                  {tAdminAccess('label')}
                </span>
                <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                  {tAdminAccess('help')}
                </p>
              </div>
              <ToggleSwitch
                checked={d.adminAccess}
                onChange={(checked) => update(i, { adminAccess: checked })}
                ariaLabel={tAdminAccess('label')}
                testId={`jmap-server-admin-access-${i}`}
              />
            </div>
            <button
              onClick={() => update(i, { oauthExpanded: !d.oauthExpanded })}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              type="button"
            >
              {d.oauthExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Per-server OAuth (optional, overrides global)
            </button>
            {d.oauthExpanded && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 ps-4 border-s border-border">
                <div>
                  <label htmlFor={labelFor(i)("oauth-client-id")} className={fieldLabelClass}>OAuth Client ID</label>
                  <input
                    id={labelFor(i)("oauth-client-id")}
                    type="text"
                    value={d.oauthClientId}
                    onChange={(e) => update(i, { oauthClientId: e.target.value })}
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label htmlFor={labelFor(i)("oauth-issuer")} className={fieldLabelClass}>OAuth Issuer URL</label>
                  <input
                    id={labelFor(i)("oauth-issuer")}
                    type="url"
                    value={d.oauthIssuerUrl}
                    onChange={(e) => update(i, { oauthIssuerUrl: e.target.value })}
                    placeholder="https://auth.example.com"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label htmlFor={labelFor(i)("oauth-secret")} className={fieldLabelClass}>OAuth Client Secret</label>
                  <input
                    id={labelFor(i)("oauth-secret")}
                    type="password"
                    value={d.oauthClientSecret}
                    onChange={(e) => update(i, { oauthClientSecret: e.target.value })}
                    placeholder={d.hasClientSecret ? '••••••••  (saved - type to replace)' : undefined}
                    className={fieldClass}
                  />
                </div>
                <div className="sm:col-span-3">
                  <label htmlFor={labelFor(i)("oauth-button")} className={fieldLabelClass}>Sign-in button label</label>
                  <input
                    id={labelFor(i)("oauth-button")}
                    type="text"
                    value={d.oauthButtonLabel}
                    onChange={(e) => update(i, { oauthButtonLabel: e.target.value })}
                    placeholder="Sign in with Google"
                    maxLength={64}
                    className={fieldClass}
                  />
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                    With a client ID, this label gives the server its own sign-in button on the login page, whichever server is selected and even while OAuth is off globally.
                  </p>
                </div>
                <div className="sm:col-span-3">
                  <label htmlFor={labelFor(i)("logout-url")} className={fieldLabelClass}>Provider logout URL</label>
                  <input
                    id={labelFor(i)("logout-url")}
                    type="url"
                    value={d.oauthEndSessionUrl}
                    onChange={(e) => update(i, { oauthEndSessionUrl: e.target.value })}
                    placeholder="https://auth.example.com/logout"
                    className={fieldClass}
                  />
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                    Where signing out sends the browser to end the provider&apos;s session, instead of the end_session_endpoint from discovery. Set it for providers that advertise none, such as Stalwart. Must be https.
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
