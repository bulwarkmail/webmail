'use client';

import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import type { VacationTemplate } from '@/lib/admin/organisation-policy';
import { sanitizeEmailHtml } from '@/lib/email-sanitization';
import { cn, generateUUID } from '@/lib/utils';
import { fillVacationTemplate, VACATION_PLACEHOLDERS } from '@/lib/vacation-templates';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/** Same cap as the sanitiser (organisation-policy.ts). */
const MAX_LIBRARY = 200;
/** What Stalwart takes for an out-of-office reply (bytes); a longer one can't be saved by users. */
export const STALWART_LIMITS = { subject: 511, body: 2047 };
const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/out-of-office';

const inputClass =
  'block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring';
const labelClass = 'mb-1 block text-xs font-medium text-foreground';

const PLACEHOLDER_HELP: Record<(typeof VACATION_PLACEHOLDERS)[number], string> = {
  name: 'the user’s name',
  email: 'their address',
  company: 'the company name from Branding',
  start: 'the first day away',
  end: 'the last day away (or the return)',
  deputy: 'the address of a colleague the user types in when picking the template',
  deputy_name: 'that colleague’s name',
};

const EXAMPLE = {
  name: 'Alex Example', email: 'alex@example.com', company: 'Example Ltd',
  start: 'Monday 21 December 2026', end: 'Monday 4 January 2027',
  deputy: 'sam@example.com', deputy_name: 'Sam Example',
};

const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Over Stalwart's limits once filled in with a typical name and dates (the placeholders grow a little). */
export function vacationTemplateTooLong(template: VacationTemplate): { subject: boolean; body: boolean } {
  const filled = fillVacationTemplate(template, EXAMPLE);
  return {
    subject: bytes(filled.subject) > STALWART_LIMITS.subject,
    body: bytes(filled.text) > STALWART_LIMITS.body || bytes(filled.html) > STALWART_LIMITS.body,
  };
}

function VacationTemplateEditor({ template, onChange, onRemove }: {
  template: VacationTemplate;
  onChange: (template: VacationTemplate) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(!template.name);
  const [html, setHtml] = useState(!!template.html);
  const set = (patch: Partial<VacationTemplate>) => onChange({ ...template, ...patch });
  const tooLong = vacationTemplateTooLong(template);
  const preview = fillVacationTemplate(template, EXAMPLE);
  return (
    <li className="rounded-md border border-border" data-testid="org-vacation-template-item">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-start text-sm hover:bg-muted"
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className={cn('truncate font-medium', !template.name && 'text-muted-foreground')}>{template.name || 'New reply'}</span>
          {template.category && <span className="max-w-[40%] shrink-0 truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{template.category}</span>}
        </button>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="h-8 shrink-0 px-2 hover:text-red-600" aria-label={`Remove ${template.name || 'reply'}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!template.name.trim() && (
        <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">A reply without a name is not saved. Give it one.</p>
      )}
      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
              <input id={`${id}-name`} data-testid="org-vacation-template-name" className={inputClass} value={template.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`${id}-category`} className={labelClass}>Category or language</label>
              <input id={`${id}-category`} className={inputClass} value={template.category} maxLength={100} placeholder="Holiday, Parental leave, Deutsch…" onChange={(e) => set({ category: e.target.value })} />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-subject`} className={labelClass}>Subject</label>
            <input id={`${id}-subject`} data-testid="org-vacation-template-subject" className={inputClass} value={template.subject} maxLength={511} placeholder="Out of office until {end}" onChange={(e) => set({ subject: e.target.value })} />
            {tooLong.subject && <p className="mt-1 text-xs text-red-600 dark:text-red-400">Longer than Stalwart takes (511 bytes). Users couldn&apos;t save it.</p>}
          </div>
          <div>
            <label htmlFor={`${id}-text`} className={labelClass}>Text</label>
            <textarea
              id={`${id}-text`}
              data-testid="org-vacation-template-text"
              rows={7}
              className={inputClass}
              value={template.text}
              placeholder={'Thank you for your message. I am away until {end}.\nFor urgent matters, please write to {deputy_name} at {deputy}.\n\n{name}\n{company}'}
              onChange={(e) => set({ text: e.target.value })}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" className="rounded border-input" checked={html} onChange={(e) => { setHtml(e.target.checked); if (!e.target.checked) set({ html: '' }); }} />
            Also an HTML version
          </label>
          {html && (
            <div>
              <label htmlFor={`${id}-html`} className={labelClass}>HTML</label>
              <textarea id={`${id}-html`} rows={6} className={cn(inputClass, 'font-mono text-xs')} value={template.html} onChange={(e) => set({ html: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">Placeholders work here too, also in links such as href=&quot;mailto:{'{deputy}'}&quot;.</p>
            </div>
          )}
          {tooLong.body && (
            <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Longer than Stalwart takes for a reply (2047 bytes, text and HTML each). Users couldn&apos;t save it.
            </p>
          )}
          <div>
            <p className={labelClass}>Preview with example values</p>
            <div className="rounded-md border border-border bg-background p-3" data-testid="org-vacation-template-preview">
              {preview.subject && <p className="mb-2 text-sm font-medium">{preview.subject}</p>}
              {preview.html
                ? <div className="text-sm [&_a]:text-primary [&_a]:underline" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(preview.html) }} />
                : preview.text ? <p className="whitespace-pre-wrap text-sm">{preview.text}</p> : <p className="text-sm text-muted-foreground">No text</p>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Organisation > Templates > Out-of-office replies (enterprise pack item
 * 11): reply texts users pick in Settings > Out of office
 * (policy.json `organisation.vacationTemplates.library`). A scope's
 * replies add to Everyone's by id; the same id replaces Everyone's reply
 * for that scope.
 */
export function VacationTemplatesSection({ draft }: { draft: OrgPolicyDraft }) {
  const library = draft.orgValue('vacationTemplates', 'library');
  const inScope = !!draft.scope;
  const own: VacationTemplate[] = inScope ? (library.own ? library.value : []) : library.value;
  const everyone = library.everyone;
  const ownIds = new Set(own.map((t) => t.id));

  const setOwn = (next: VacationTemplate[]) => {
    if (inScope && next.length === 0) draft.clearOrgValue('vacationTemplates', 'library');
    else draft.setOrgValue('vacationTemplates', 'library', next);
  };
  const add = () => setOwn([...own, { id: generateUUID(), name: '', category: '', subject: '', text: '', html: '' }]);
  const change = (index: number, template: VacationTemplate) => setOwn(own.map((t, i) => (i === index ? template : t)));
  const remove = (index: number) => setOwn(own.filter((_, i) => i !== index));
  const replaceInScope = (template: VacationTemplate) => setOwn([...own, { ...template }]);
  const total = new Set([...everyone.map((t) => t.id), ...own.map((t) => t.id)]).size;

  return (
    <SettingsSection
      id="vacation-templates"
      title="Out-of-office replies"
      description="Users pick one of these under Settings > Out of office, Bulwark fills in the placeholders, and they can change the text before it is switched on."
    >
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="org-vacation-placeholders">
          <p className="mb-1">
            Placeholders use single braces, like the organisation signature (not the {'{{double}}'} braces of mail templates).
            A line whose placeholders are all empty is left out, so &quot;I am back on {'{end}'}&quot; disappears when the user sets no end.
          </p>
          <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {VACATION_PLACEHOLDERS.map((key) => (
              <li key={key}><code className="text-foreground">{`{${key}}`}</code>: {PLACEHOLDER_HELP[key]}</li>
            ))}
          </ul>
          <p className="mt-1">Dates are written in the user&apos;s language and time zone. Stalwart takes at most 511 bytes of subject and 2047 bytes of text.</p>
        </div>

        {inScope && (
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">From Everyone</p>
            {everyone.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone has no replies.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="org-vacation-template-inherited">
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
              Users in this scope get Everyone&apos;s replies and these. A reply changed here replaces Everyone&apos;s for this scope only.
            </p>
          </div>
        )}

        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="org-vacation-template-empty">
            {inScope ? 'Nothing added for this scope.' : 'No replies yet. Users write their own.'}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="org-vacation-template-list">
            {own.map((template, index) => (
              <VacationTemplateEditor key={template.id} template={template} onChange={(t) => change(index, t)} onRemove={() => remove(index)} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={total >= MAX_LIBRARY} data-testid="org-vacation-template-add">
            <Plus className="me-1 h-4 w-4" /> Add reply
          </Button>
          {total >= MAX_LIBRARY && <span className="text-xs text-muted-foreground">A library holds at most {MAX_LIBRARY} replies.</span>}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-primary underline-offset-2 hover:underline">
            How out-of-office templates work
          </a>
        </div>
      </div>
    </SettingsSection>
  );
}
