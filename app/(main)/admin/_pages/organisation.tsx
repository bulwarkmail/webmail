'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/admin/badge';
import { inputClass } from '@/components/admin/config-items';
import { OrgPage, scopeMatchSummary } from '@/components/admin/org/org-page';
import { PolicyFileSection } from '@/components/admin/org/policy-file-section';
import { EVERYONE, useOrgPolicyDraft, type OrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { resolvePolicy, type PolicyScope } from '@/lib/admin/policy-scopes';
import { cn } from '@/lib/utils';

const fieldLabelClass = 'mb-1 block text-[0.6875rem] font-medium text-muted-foreground';
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const GROUP_RE = /^[^\s@]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

function newScopeId(existing: PolicyScope[]): string {
  const taken = new Set(existing.map((s) => s.id));
  for (;;) {
    const id = `scope-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/** A comma-separated list edited as text and stored as an array when the field loses focus. */
function ListField({ label, value, placeholder, valid, onCommit }: {
  label: string;
  value: string[];
  placeholder: string;
  valid: (item: string) => boolean;
  onCommit: (items: string[]) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value.join(', ');
  const invalid = splitList(shown).filter((item) => !valid(item));
  return (
    <label className="block min-w-0 flex-1">
      <span className={fieldLabelClass}>{label}</span>
      <input
        type="text"
        value={shown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn(inputClass, 'w-full', invalid.length > 0 && 'border-destructive')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === null) return;
          onCommit(splitList(text));
          setText(null);
        }}
      />
      {invalid.length > 0 && (
        <span className="mt-1 block text-xs text-destructive">Not valid, ignored when saved: {invalid.join(', ')}</span>
      )}
    </label>
  );
}

function ScopeCard({ draft, scope, index, count }: { draft: OrgPolicyDraft; scope: PolicyScope; index: number; count: number }) {
  const move = (delta: number) => draft.update((p) => {
    const list = p.scopes ?? [];
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
  });
  const overrides = Object.keys(scope.policy.features ?? {}).length
    + Object.keys(scope.policy.restrictions ?? {}).length
    + Object.keys(scope.policy.defaults ?? {}).length
    + Object.values(scope.policy.organisation ?? {}).reduce((n, section) => n + Object.keys(section ?? {}).length, 0);
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3" data-testid={`org-scope-${scope.id}`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[10rem] flex-1">
          <span className={fieldLabelClass}>Name</span>
          <input
            type="text"
            value={scope.label}
            className={cn(inputClass, 'w-full')}
            onChange={(e) => draft.updateScope(scope.id, (s) => { s.label = e.target.value; })}
          />
        </label>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => move(-1)} disabled={index === 0} aria-label="Move up" title="Move up"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => move(1)} disabled={index === count - 1} aria-label="Move down" title="Move down"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Remove" title="Remove"
            onClick={() => draft.update((p) => { p.scopes = (p.scopes ?? []).filter((s) => s.id !== scope.id); })}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ListField
          label="Domains"
          value={scope.match.domains ?? []}
          placeholder="example.com, *.example.com"
          valid={(d) => DOMAIN_RE.test(d)}
          onCommit={(domains) => draft.updateScope(scope.id, (s) => { s.match = { ...s.match, domains }; })}
        />
        <ListField
          label="Groups"
          value={scope.match.groups ?? []}
          placeholder="sales@example.com"
          valid={(g) => GROUP_RE.test(g)}
          onCommit={(groups) => draft.updateScope(scope.id, (s) => { s.match = { ...s.match, groups }; })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone="muted">{overrides === 0 ? 'No settings of its own yet' : `${overrides} setting${overrides === 1 ? '' : 's'} of its own`}</Badge>
        <button type="button" className="underline-offset-2 hover:underline" onClick={() => draft.setScopeId(scope.id)}>
          {draft.scopeId === scope.id ? 'Selected on the Organisation pages' : 'Edit its settings on the Organisation pages'}
        </button>
      </div>
    </div>
  );
}

function sourceLabel(source: string, scopes: PolicyScope[]): string {
  if (source === 'global') return 'Everyone';
  return scopes.find((s) => s.id === source)?.label ?? source;
}

function valueAt(policy: Record<string, unknown>, path: string): unknown {
  const [root, ...rest] = path.split('.');
  // Keys of features, restrictions and defaults never contain dots; organisation paths are section.key.
  let value: unknown = policy[root];
  for (const part of rest) value = (value as Record<string, unknown> | undefined)?.[part];
  return value;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value || '(empty)';
  const json = JSON.stringify(value);
  return json && json.length > 80 ? `${json.slice(0, 80)}…` : String(json);
}

function EffectivePolicy({ draft }: { draft: OrgPolicyDraft }) {
  const [email, setEmail] = useState('');
  const [groupsText, setGroupsText] = useState('');
  const subject = email.includes('@') ? { email: email.trim().toLowerCase(), groups: splitList(groupsText) } : null;
  const resolved = useMemo(
    () => (draft.policy && subject ? resolvePolicy(draft.policy, subject) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.policy, subject?.email, subject?.groups.join(',')],
  );
  const rows = resolved
    ? Object.entries(resolved.sources).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="block min-w-0 flex-1">
          <span className={fieldLabelClass}>User address</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="anna@example.com"
            className={cn(inputClass, 'w-full')} spellCheck={false} autoComplete="off" />
        </label>
        <label className="block min-w-0 flex-1">
          <span className={fieldLabelClass}>Groups the user is a member of</span>
          <input type="text" value={groupsText} onChange={(e) => setGroupsText(e.target.value)} placeholder="sales@example.com"
            className={cn(inputClass, 'w-full')} spellCheck={false} autoComplete="off" />
        </label>
      </div>
      {resolved && (
        <div className="space-y-3" data-testid="org-effective-policy">
          <p className="text-sm text-foreground">
            {resolved.matched.length === 0
              ? 'No domain or group applies; this user gets Everyone\'s settings.'
              : `Applies, in this order: Everyone, ${resolved.matched.map((id) => sourceLabel(id, draft.scopes)).join(', ')}.`}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything is at Bulwark&apos;s defaults.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-start font-medium">Setting</th>
                    <th className="px-3 py-2 text-start font-medium">Value</th>
                    <th className="px-3 py-2 text-start font-medium">Set by</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([path, source]) => (
                    <tr key={path} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-xs break-all">{path}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all"><div className="min-w-[5ch]">{formatValue(valueAt(resolved.policy as unknown as Record<string, unknown>, path))}</div></td>
                      <td className="px-3 py-1.5 text-xs">{sourceLabel(source, draft.scopes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Bulwark can only see groups that have a mailbox: a user counts as a member when the group&apos;s account is in their session.
          </p>
        </div>
      )}
    </div>
  );
}

export function OrganisationPage() {
  const draft = useOrgPolicyDraft('organisation');
  const addScope = (kind: 'domain' | 'group') => draft.update((p) => {
    const id = newScopeId(p.scopes ?? []);
    p.scopes = [...(p.scopes ?? []), {
      id,
      label: kind === 'domain' ? 'New domain' : 'New group',
      match: {},
      policy: {},
    }];
  });
  return (
    <OrgPage pageId="organisation" draft={draft} scoped={false}>
      <SettingsSection
        id="scopes"
        title="Domains and groups"
        description="Each entry gives the users of some domains or the members of some groups their own settings. Pick one at the top of the other Organisation pages to change its settings; everything it doesn't change comes from Everyone. When several apply, domains come first, then groups, each in the order of this list, and the later one wins."
      >
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => addScope('domain')}>
            <Plus className="h-3.5 w-3.5" /> Add domains
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => addScope('group')}>
            <Plus className="h-3.5 w-3.5" /> Add groups
          </Button>
        </div>
        {draft.scopes.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet: every user gets Everyone&apos;s settings.</p>
        ) : (
          <div className="space-y-3">
            {draft.scopes.map((scope, index) => (
              <ScopeCard key={scope.id} draft={draft} scope={scope} index={index} count={draft.scopes.length} />
            ))}
          </div>
        )}
        {draft.scopeId !== EVERYONE && draft.scope && (
          <p className="text-xs text-muted-foreground">
            Selected for editing: {draft.scope.label} ({scopeMatchSummary(draft.scope)}).
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        id="effective"
        title="Effective policy"
        description="What a given user gets, and which entry set each value. Uses the settings on this page, saved or not."
      >
        <EffectivePolicy draft={draft} />
      </SettingsSection>

      <PolicyFileSection draft={draft} />
    </OrgPage>
  );
}
