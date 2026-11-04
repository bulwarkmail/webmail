'use client';

import type { ReactNode } from 'react';
import { Loader2, Lock, RotateCcw } from '@/components/icons';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { AdminLink } from '@/components/admin/admin-link';
import { SectionNav, SettingItem } from '@/components/settings/settings-section';
import { adminPageDef, type AdminPageId } from '@/lib/admin/admin-nav';
import type { RestrictionKeyDef } from '@/lib/admin/restriction-keys';
import type { PolicyScope } from '@/lib/admin/policy-scopes';
import { cn } from '@/lib/utils';
import { EVERYONE, type OrgPolicyDraft } from './use-org-policy-draft';

export const chipClass = (selected: boolean) => cn(
  'h-8 px-3 rounded-md text-sm font-medium transition-colors max-w-full truncate',
  selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-accent hover:text-accent-foreground',
);

/** "example.com, sales@example.com": what a scope matches, for labels. */
export function scopeMatchSummary(scope: PolicyScope): string {
  const parts = [...(scope.match.domains ?? []), ...(scope.match.groups ?? [])];
  return parts.length > 0 ? parts.join(', ') : 'matches nobody yet';
}

/**
 * Which part of the organisation an Organisation page edits: Everyone, or
 * one domain or group scope. Chips on wide screens; they wrap at phone width.
 */
export function ScopeBar({ draft }: { draft: OrgPolicyDraft }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3" data-testid="org-scope-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground me-1">Applies to</span>
        <button
          type="button"
          aria-pressed={draft.scopeId === EVERYONE}
          className={chipClass(draft.scopeId === EVERYONE)}
          onClick={() => draft.setScopeId(EVERYONE)}
        >
          Everyone
        </button>
        {draft.scopes.map((scope) => (
          <button
            key={scope.id}
            type="button"
            aria-pressed={draft.scopeId === scope.id}
            className={chipClass(draft.scopeId === scope.id)}
            title={scopeMatchSummary(scope)}
            onClick={() => draft.setScopeId(scope.id)}
          >
            {scope.label}
          </button>
        ))}
        <AdminLink href="/admin/organisation" className="ms-auto text-xs text-muted-foreground underline-offset-2 hover:underline">
          Manage domains and groups
        </AdminLink>
      </div>
      {draft.scope && (
        <p className="mt-2 text-xs text-muted-foreground">
          Changes here apply to {scopeMatchSummary(draft.scope)} only. Settings this scope doesn&apos;t change come from Everyone.
        </p>
      )}
    </div>
  );
}

/** "From Everyone: 15 minutes" with a reset, under a field a scope inherits or overrides. */
export function InheritNote({ draft, own, everyone, onReset }: {
  draft: OrgPolicyDraft;
  own: boolean;
  everyone: ReactNode;
  onReset: () => void;
}) {
  if (!draft.scope) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {own ? <span>Everyone: {everyone}</span> : <span>From Everyone: {everyone}</span>}
      {own && (
        <button type="button" onClick={onReset} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
          <RotateCcw className="h-3 w-3" /> Use Everyone&apos;s value
        </button>
      )}
    </p>
  );
}

/**
 * Lock, hide and allowed values of one restriction key, at the selected
 * scope. Every user-facing option of the Organisation features is
 * restricted through this, never through a flag of its own.
 */
export function RestrictionRow({ draft, def }: { draft: OrgPolicyDraft; def: RestrictionKeyDef }) {
  const { value, own, everyone } = draft.restriction(def.key);
  const current = value ?? {};
  const modes = def.modes ?? ['locked', 'hidden'];
  const set = (patch: Partial<typeof current>) => draft.setRestriction(def.key, { ...current, ...patch });
  const describe = (r: typeof current | undefined) =>
    r?.hidden ? 'hidden' : r?.locked ? 'locked' : r?.allowedValues?.length ? `limited to ${r.allowedValues.join(', ')}` : 'users choose';
  return (
    <SettingItem label={def.label} description={def.description}>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <div className="flex flex-wrap items-center gap-3">
          {modes.includes('locked') && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="rounded border-input" checked={!!current.locked} onChange={(e) => set({ locked: e.target.checked })} />
              <Lock className="h-3 w-3" /> Lock
            </label>
          )}
          {modes.includes('hidden') && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="rounded border-input" checked={!!current.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
              Hide
            </label>
          )}
          {modes.includes('allowedValues') && def.allowedValues?.map((option) => {
            const allowed = current.allowedValues as string[] | undefined;
            const checked = !allowed || allowed.length === 0 || allowed.includes(option);
            return (
              <label key={option} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="rounded border-input"
                  checked={checked}
                  onChange={(e) => {
                    const base = allowed && allowed.length > 0 ? allowed : def.allowedValues!;
                    const next = e.target.checked ? [...new Set([...base, option])] : base.filter((v) => v !== option);
                    set({ allowedValues: next.length === def.allowedValues!.length ? undefined : next });
                  }}
                />
                {option}
              </label>
            );
          })}
        </div>
        <InheritNote draft={draft} own={own} everyone={describe(everyone)} onReset={() => draft.setRestriction(def.key, undefined)} />
      </div>
    </SettingItem>
  );
}

/**
 * The frame of an Organisation page: title and the one sentence on what it
 * does for users, the scope bar, messages, and the save bar.
 */
export function OrgPage({ pageId, draft, children, scoped = true }: {
  pageId: AdminPageId;
  draft: OrgPolicyDraft;
  children: ReactNode;
  /** Pages whose settings can be set per scope show the scope bar. */
  scoped?: boolean;
}) {
  const page = adminPageDef(pageId);
  return (
    <div>
      <AdminPageHeader title={page.label} description={page.description} />
      {draft.loading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
        </div>
      ) : (
        <div className="space-y-10">
          {scoped && <ScopeBar draft={draft} />}
          <SectionNav />
          {children}
        </div>
      )}
      <AdminSaveBar
        dirty={draft.dirty}
        saving={draft.saving}
        onSave={() => void draft.save()}
        onDiscard={draft.discard}
        saveLabel="Save"
        note="Users get the change within 15 minutes"
      />
    </div>
  );
}
