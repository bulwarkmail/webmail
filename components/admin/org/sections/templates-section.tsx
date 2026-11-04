'use client';

import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { TemplateBodyPreview } from '@/components/templates/template-body-preview';
import { Button } from '@/components/ui/button';
import type { OrgTemplate } from '@/lib/admin/organisation-policy';
import { restrictionKeysForPage } from '@/lib/admin/restriction-keys';
import { cn, generateUUID } from '@/lib/utils';
import { RestrictionRow } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const inputClass =
  'block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden ' +
  'focus-visible:border-ring';
const labelClass = 'mb-1 block text-xs font-medium text-foreground';

/** Same cap as the sanitiser (organisation-policy.ts): more are not saved. */
const MAX_LIBRARY = 200;

function TemplateEditor({ template, onChange, onRemove }: {
  template: OrgTemplate;
  onChange: (template: OrgTemplate) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(!template.name);
  const set = (patch: Partial<OrgTemplate>) => onChange({ ...template, ...patch });
  return (
    <li className="rounded-md border border-border" data-testid="org-template-item">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-start text-sm hover:bg-muted"
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className={cn('truncate font-medium', !template.name && 'text-muted-foreground')}>{template.name || 'New template'}</span>
          {template.category && <span className="max-w-[40%] shrink-0 truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{template.category}</span>}
        </button>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="h-8 shrink-0 px-2 hover:text-red-600" aria-label={`Remove ${template.name || 'template'}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!template.name.trim() && (
        <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">A template without a name is not saved. Give it one.</p>
      )}
      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
              <input id={`${id}-name`} data-testid="org-template-name" className={inputClass} value={template.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`${id}-category`} className={labelClass}>Category</label>
              <input id={`${id}-category`} className={inputClass} value={template.category} maxLength={100} onChange={(e) => set({ category: e.target.value })} />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-subject`} className={labelClass}>Subject</label>
            <input id={`${id}-subject`} data-testid="org-template-subject" className={inputClass} value={template.subject} onChange={(e) => set({ subject: e.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-body`} className={labelClass}>Text</label>
            <textarea
              id={`${id}-body`}
              data-testid="org-template-body"
              rows={6}
              className={cn(inputClass, template.isHTML && 'font-mono text-xs')}
              value={template.body}
              onChange={(e) => set({ body: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Placeholders such as {'{{recipient_name}}'} work as in users&apos; own templates: users fill them in when they pick the template.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" className="rounded border-input" checked={!!template.isHTML} onChange={(e) => set({ isHTML: e.target.checked })} />
            The text is HTML
          </label>
          <div>
            <p className={labelClass}>Preview</p>
            <div className="rounded-md border border-border bg-background p-3" data-testid="org-template-preview">
              {template.subject && <p className="mb-2 text-sm font-medium">{template.subject}</p>}
              {template.body ? <TemplateBodyPreview template={template} /> : <p className="text-sm text-muted-foreground">No text</p>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Organisation > Templates (feature 3): the admin's template library
 * (policy.json `organisation.templates.library`) at the selected scope, and
 * the restrictions on users' own and team templates. A scope's library adds
 * to Everyone's by id; the same id replaces Everyone's template for that
 * scope (mergeOrganisation).
 */
export function TemplatesSection({ draft }: { draft: OrgPolicyDraft }) {
  const library = draft.orgValue('templates', 'library');
  const inScope = !!draft.scope;
  const own: OrgTemplate[] = inScope ? (library.own ? library.value : []) : library.value;
  const everyone = library.everyone;
  const ownIds = new Set(own.map((t) => t.id));

  const setOwn = (next: OrgTemplate[]) => {
    if (inScope && next.length === 0) draft.clearOrgValue('templates', 'library');
    else draft.setOrgValue('templates', 'library', next);
  };
  const add = () => setOwn([...own, { id: generateUUID(), name: '', subject: '', body: '', isHTML: false, category: '' }]);
  const change = (index: number, template: OrgTemplate) => setOwn(own.map((t, i) => (i === index ? template : t)));
  const remove = (index: number) => setOwn(own.filter((_, i) => i !== index));
  const replaceInScope = (template: OrgTemplate) => setOwn([...own, { ...template }]);

  const total = new Set([...everyone.map((t) => t.id), ...own.map((t) => t.id)]).size;

  return (
    <>
      <SettingsSection
        id="library"
        title="Organisation library"
        description="Users see these templates under “Organisation” in the template picker and in Settings > Composing > Email templates. They can use and copy them, not change them."
      >
        <div className="space-y-4">
          {inScope && (
            <div>
              <p className="mb-2 text-sm font-medium text-foreground">From Everyone</p>
              {everyone.length === 0 ? (
                <p className="text-sm text-muted-foreground">Everyone&apos;s library is empty.</p>
              ) : (
                <ul className="space-y-1.5" data-testid="org-template-inherited">
                  {everyone.map((template) => (
                    <li key={template.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{template.name}</span>
                      {ownIds.has(template.id) ? (
                        <span className="text-xs text-muted-foreground">Changed for this scope</span>
                      ) : (
                        <button type="button" onClick={() => replaceInScope(template)} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                          <RotateCcw className="h-3 w-3" /> Change for this scope
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-4 mb-1 text-sm font-medium text-foreground">For this scope</p>
              <p className="mb-2 text-xs text-muted-foreground">
                Users in this scope get Everyone&apos;s templates and these. A template changed here replaces Everyone&apos;s for this scope only.
              </p>
            </div>
          )}

          {own.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="org-template-empty">
              {inScope ? 'Nothing added for this scope.' : 'No templates yet. Users only have their own.'}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="org-template-list">
              {own.map((template, index) => (
                <TemplateEditor key={template.id} template={template} onChange={(t) => change(index, t)} onRemove={() => remove(index)} />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={add} disabled={total >= MAX_LIBRARY} data-testid="org-template-add">
              <Plus className="me-1 h-4 w-4" /> Add template
            </Button>
            {total >= MAX_LIBRARY && <span className="text-xs text-muted-foreground">A library holds at most {MAX_LIBRARY} templates.</span>}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        id="user-templates"
        title="Personal and team templates"
        description="On Stalwart 1.0 and later, users' own templates are kept in their account, and the members of a group mailbox share its team templates. On older servers, users keep their own templates in the browser and there are no team templates."
      >
        <div>
          {restrictionKeysForPage('org-templates').map((def) => <RestrictionRow key={def.key} draft={draft} def={def} />)}
        </div>
      </SettingsSection>
    </>
  );
}
