'use client';

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, Plus, RotateCcw, Trash2 } from '@/components/icons';
import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_ORGANISATION_POLICY,
  LABEL_SENSITIVITIES,
  isLabelExtraHeaderName,
  type ClassificationLabel,
  type LabelSensitivity,
  type OrganisationPolicy,
} from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import { cn, generateUUID } from '@/lib/utils';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

type Labels = OrganisationPolicy['labels'];
const KEYS = ['list', 'defaultId', 'required', 'extraHeader'] as const;
const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/classification-labels';
/** Same cap as the sanitiser. */
const MAX_LABELS = 50;

const inputClass =
  'block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring';
const labelClass = 'mb-1 block text-xs font-medium text-foreground';

const SENSITIVITY_NAMES: Record<LabelSensitivity, string> = {
  '': 'None',
  Personal: 'Personal',
  Private: 'Private',
  'Company-Confidential': 'Company-Confidential (Outlook: Confidential)',
};

/** The VS-NfD warning, here and in the docs. */
function VsNfdWarning() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200" data-testid="org-labels-vsnfd-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p>
        A label only marks the message. It doesn&apos;t make mail meet the VS-NfD handling rules (VSA § 50, § 55): that
        needs approved IT and BSI-approved encryption. Bulwark&apos;s S/MIME and PGP plugins and Stalwart are not
        BSI-approved products. Anyone can forge a received label, so Bulwark only shows it and never relaxes anything because of it.
      </p>
    </div>
  );
}

function LabelEditor({ label, index, count, extraHeader, onChange, onMove, onRemove }: {
  label: ClassificationLabel;
  index: number;
  count: number;
  extraHeader: string;
  onChange: (label: ClassificationLabel) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(!label.name);
  const set = (patch: Partial<ClassificationLabel>) => onChange({ ...label, ...patch });
  const name = label.name || 'New label';
  return (
    <li className="rounded-md border border-border" data-testid="org-label-item">
      <div className="flex items-center gap-1 p-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-start text-sm hover:bg-muted"
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: label.color }} aria-hidden="true" />
          <span className={cn('truncate font-medium', !label.name && 'text-muted-foreground')}>{name}</span>
          {label.subjectPrefix && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{label.subjectPrefix}</span>}
        </button>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${name} up`}>
          <ChevronUp className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${name} down`}>
          <ChevronDown className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="h-8 px-2 hover:text-red-600" aria-label={`Remove ${name}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {!label.name.trim() && <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">A label without a name is not saved. Give it one.</p>}
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-border p-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
            <input id={`${id}-name`} data-testid="org-label-name" className={inputClass} value={label.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-color`} className={labelClass}>Colour</label>
            <div className="flex items-center gap-2">
              <input id={`${id}-color`} type="color" className="h-9 w-12 shrink-0 cursor-pointer rounded border border-input bg-background" value={label.color} onChange={(e) => set({ color: e.target.value.toLowerCase() })} />
              <span className="font-mono text-xs text-muted-foreground">{label.color}</span>
            </div>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-description`} className={labelClass}>Description</label>
            <input id={`${id}-description`} className={inputClass} value={label.description} maxLength={1000} placeholder="Shown under the label in the composer's picker" onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-marking`} className={labelClass}>Marking (SIO-Label header)</label>
            <input id={`${id}-marking`} data-testid="org-label-marking" className={inputClass} value={label.marking} maxLength={200} placeholder={label.name.toUpperCase() || 'CONFIDENTIAL'} onChange={(e) => set({ marking: e.target.value.replace(/["\\]/g, '') })} />
            <p className="mt-1 text-xs text-muted-foreground">Empty uses the name. Received mail is matched by this text.</p>
          </div>
          <div>
            <label htmlFor={`${id}-sensitivity`} className={labelClass}>Sensitivity header</label>
            <select id={`${id}-sensitivity`} data-testid="org-label-sensitivity" className={inputClass} value={label.sensitivity} onChange={(e) => set({ sensitivity: e.target.value as LabelSensitivity })}>
              {LABEL_SENSITIVITIES.map((value) => <option key={value} value={value}>{SENSITIVITY_NAMES[value]}</option>)}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">Outlook shows it above the message.</p>
          </div>
          <div>
            <label htmlFor={`${id}-prefix`} className={labelClass}>Subject prefix</label>
            <input id={`${id}-prefix`} data-testid="org-label-prefix" className={inputClass} value={label.subjectPrefix} maxLength={60} placeholder="[Confidential]" onChange={(e) => set({ subjectPrefix: e.target.value })} />
            <p className="mt-1 text-xs text-muted-foreground">Added in front of the subject when the mail goes out, once.</p>
          </div>
          {extraHeader && (
            <div>
              <label htmlFor={`${id}-extra`} className={labelClass}>{extraHeader} value</label>
              <input id={`${id}-extra`} data-testid="org-label-extra" className={inputClass} value={label.extraHeaderValue} maxLength={500} onChange={(e) => set({ extraHeaderValue: e.target.value })} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Organisation > Classification (enterprise pack item 3): the labels users
 * pick in the composer (policy.json `organisation.labels`), the default,
 * whether a label is required, and an extra header for gateways. A scope
 * that sets labels replaces Everyone's scheme as a whole, so the scope
 * either uses Everyone's labels or has all of its own.
 */
export function LabelsSection({ draft }: { draft: OrgPolicyDraft }) {
  const id = useId();
  const inScope = !!draft.scope;
  const scopeOwn = inScope && KEYS.some((key) => draft.orgValue('labels', key).own);
  const editing = !inScope || scopeOwn;
  const value = <K extends keyof Labels>(key: K): Labels[K] => {
    const v = draft.orgValue('labels', key);
    if (!inScope) return v.value;
    if (!scopeOwn) return v.everyone;
    return v.own ? v.value : DEFAULT_ORGANISATION_POLICY.labels[key];
  };
  const everyone = {
    list: draft.orgValue('labels', 'list').everyone,
  };
  const list = value('list');
  const defaultId = value('defaultId');
  const required = value('required');
  const extraHeader = value('extraHeader');

  const set = <K extends keyof Labels>(key: K, next: Labels[K]) => draft.setOrgValue('labels', key, next);
  const setAll = (labels: Labels) => { for (const key of KEYS) draft.setOrgValue('labels', key, labels[key] as never); };
  const useOwn = () => setAll(JSON.parse(JSON.stringify({
    list: everyone.list,
    defaultId: draft.orgValue('labels', 'defaultId').everyone,
    required: draft.orgValue('labels', 'required').everyone,
    extraHeader: draft.orgValue('labels', 'extraHeader').everyone,
  })) as Labels);
  const useEveryone = () => { for (const key of KEYS) draft.clearOrgValue('labels', key); };

  const setList = (next: ClassificationLabel[]) => {
    set('list', next);
    if (defaultId && !next.some((l) => l.id === defaultId)) set('defaultId', '');
    if (next.length === 0 && required) set('required', false);
  };
  const add = () => setList([...list, { id: generateUUID().slice(0, 12), name: '', color: '#6b7280', description: '', marking: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' }]);
  const change = (index: number, label: ClassificationLabel) => setList(list.map((l, i) => (i === index ? label : l)));
  const remove = (index: number) => setList(list.filter((_, i) => i !== index));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setList(next);
  };
  const applyPreset = (presetId: string) => {
    const preset = LABEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    set('list', JSON.parse(JSON.stringify(preset.list)));
    set('defaultId', preset.defaultId);
  };

  // The extra header name is typed freely and stored once it is a valid name.
  const [headerText, setHeaderText] = useState(extraHeader);
  useEffect(() => { setHeaderText(extraHeader); }, [extraHeader]);
  const headerInvalid = headerText.trim() !== '' && !isLabelExtraHeaderName(headerText);
  const onHeader = (text: string) => {
    setHeaderText(text);
    const next = text.trim();
    if (next === '' || isLabelExtraHeaderName(next)) set('extraHeader', next);
  };

  return (
    <SettingsSection
      id="labels"
      title="Classification labels"
      description="Users pick a label in the composer, and sent mail carries it in its headers and subject. Received mail with a known label shows it. No labels turns this off."
    >
      <div className="space-y-4">
        <VsNfdWarning />

        {inScope && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm" data-testid="org-labels-scope">
            <span>{scopeOwn ? 'This scope has its own labels. They replace Everyone\u2019s.' : 'This scope uses Everyone\u2019s labels.'}</span>
            {scopeOwn ? (
              <Button type="button" variant="outline" size="sm" onClick={useEveryone}>
                <RotateCcw className="me-1 h-3.5 w-3.5" /> Use Everyone&apos;s labels
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={useOwn} data-testid="org-labels-own">
                Set labels for this scope
              </Button>
            )}
          </div>
        )}

        {editing ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`${id}-preset`} className="text-sm text-muted-foreground">Start from a preset</label>
              <select
                id={`${id}-preset`}
                data-testid="org-labels-preset"
                className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm"
                value=""
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">Choose…</option>
                {LABEL_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">Replaces the list below.</span>
            </div>

            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="org-labels-empty">No labels. The composer shows no label picker.</p>
            ) : (
              <ul className="space-y-2" data-testid="org-labels-list">
                {list.map((label, index) => (
                  <LabelEditor
                    key={label.id}
                    label={label}
                    index={index}
                    count={list.length}
                    extraHeader={extraHeader}
                    onChange={(l) => change(index, l)}
                    onMove={(delta) => move(index, delta)}
                    onRemove={() => remove(index)}
                  />
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={add} disabled={list.length >= MAX_LABELS} data-testid="org-labels-add">
                <Plus className="me-1 h-4 w-4" /> Add label
              </Button>
              {list.length >= MAX_LABELS && <span className="text-xs text-muted-foreground">At most {MAX_LABELS} labels.</span>}
            </div>

            <div>
              <SettingItem label="Default label" description="New messages start with it. Replies and forwards keep the original's label.">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-56"
                  data-testid="org-labels-default"
                  value={defaultId}
                  disabled={list.length === 0}
                  onChange={(e) => set('defaultId', e.target.value)}
                >
                  <option value="">None</option>
                  {list.filter((l) => l.name.trim()).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </SettingItem>
              <SettingItem
                label="Require a label"
                description="Sending asks for a label until one is picked. A quick reply without one opens the full composer."
              >
                <ToggleSwitch checked={required} disabled={list.length === 0} onChange={(v) => set('required', v)} testId="org-labels-required" />
              </SettingItem>
              <SettingItem
                label="Extra header"
                description="A header of your own each label can set, for a mail gateway or DLP (for example X-Classification, or msip_labels for Microsoft Purview). Empty writes none."
              >
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  <input
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="X-Classification"
                    value={headerText}
                    onChange={(e) => onHeader(e.target.value)}
                    aria-invalid={headerInvalid || undefined}
                    data-testid="org-labels-extra-header"
                    className={cn(inputClass, 'sm:w-56', headerInvalid && 'border-red-500')}
                  />
                  {headerInvalid && (
                    <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                      A header name has no spaces or colons. Bulwark writes this one itself, or the mail server won't take it.
                    </p>
                  )}
                </div>
              </SettingItem>
            </div>
          </>
        ) : (
          <div data-testid="org-labels-inherited">
            {everyone.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone has no labels.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {everyone.list.map((l) => (
                  <li key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} aria-hidden="true" />
                    {l.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Calendar invitations, read receipts, phishing reports and unsubscribe mails go out without a label.{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            How labels work
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
