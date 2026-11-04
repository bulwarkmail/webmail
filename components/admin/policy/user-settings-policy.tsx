'use client';

import { useState } from 'react';
import { Lock, Plus, RotateCcw } from '@/components/icons';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/admin/badge';
import { AdminLink } from '@/components/admin/admin-link';
import { inputClass, RevertButton } from '@/components/admin/config-items';
import { chipClass, scopeMatchSummary } from '@/components/admin/org/org-page';
import { EVERYONE, useOrgScopeStore } from '@/components/admin/org/use-org-policy-draft';
import type { SettingRestriction, SettingsPolicy } from '@/lib/admin/types';
import { restrictionKeysForPage, type RestrictionKeyDef } from '@/lib/admin/restriction-keys';
import {
  PRESETTABLE_SETTINGS,
  defaultAt,
  describeSettingValue,
  effectiveDefault,
  isLockableSetting,
  otherDefaultKeys,
  parseFreeSettingValue,
  presettableSetting,
  restrictionAt,
  withDefaultAt,
  withRestrictionAt,
  type PolicySettingValue,
  type PresettableSetting,
} from '@/lib/admin/policy-settings';
import { toastDurationAtLeast } from '@/lib/accessibility-settings';
import { cn } from '@/lib/utils';

type PolicyChange = (change: (policy: SettingsPolicy) => SettingsPolicy) => void;

interface SectionProps {
  policy: SettingsPolicy;
  onChange: PolicyChange;
}

const subLabelClass = 'mt-2 text-xs font-semibold text-muted-foreground';
const groupLabelClass = 'mt-4 text-sm font-medium text-foreground';
const noteClass = 'text-xs text-muted-foreground';

// The lock list leaves out what the store would not lock anyway.
const LOCKABLE = restrictionKeysForPage('policy').filter((def) => isLockableSetting(def.key));

/** Minimums the toast duration lock offers; 5 seconds is already the default. */
const TOAST_MINIMUMS = [10, 20, 60];

const UNLOCKABLE_NOTE =
  'Text size, contrast, motion, fonts and the reading aids can be given a default below but not locked: a lock could leave someone unable to read or use Bulwark.';

/** The scope this page edits: the one picked on any Organisation page, if it still exists. */
export function useScopeId(policy: SettingsPolicy): [string, (id: string) => void] {
  const scopeId = useOrgScopeStore((s) => s.scopeId);
  const setScopeId = useOrgScopeStore((s) => s.setScopeId);
  const exists = scopeId === EVERYONE || (policy.scopes ?? []).some((s) => s.id === scopeId);
  return [exists ? scopeId : EVERYONE, setScopeId];
}

/** Everyone or one domain or group scope, for the locks and presets below it. */
export function ScopePicker({ policy, scopeId, onPick }: { policy: SettingsPolicy; scopeId: string; onPick: (id: string) => void }) {
  const scopes = policy.scopes ?? [];
  if (scopes.length === 0) return null;
  const scope = scopes.find((s) => s.id === scopeId);
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Applies to">
        <span className="me-1 text-xs font-medium text-muted-foreground">Applies to</span>
        <button type="button" aria-pressed={scopeId === EVERYONE} className={chipClass(scopeId === EVERYONE)} onClick={() => onPick(EVERYONE)}>
          Everyone
        </button>
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={scopeId === s.id}
            className={chipClass(scopeId === s.id)}
            title={scopeMatchSummary(s)}
            onClick={() => onPick(s.id)}
          >
            {s.label}
          </button>
        ))}
        <AdminLink href="/admin/organisation" className="ms-auto text-xs text-muted-foreground underline-offset-2 hover:underline">
          Manage domains and groups
        </AdminLink>
      </div>
      {scope && (
        <p className="mt-2 text-xs text-muted-foreground">
          Changes here apply to {scopeMatchSummary(scope)} only. What this scope doesn&apos;t change comes from Everyone.
        </p>
      )}
    </div>
  );
}

/** "From Everyone: On" under a row, with a way back to Everyone's value. */
export function InheritLine({ scoped, own, everyone, onReset }: { scoped: boolean; own: boolean; everyone: string; onReset: () => void }) {
  if (!scoped) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>{own ? 'Everyone' : 'From Everyone'}: {everyone}</span>
      {own && (
        <button type="button" onClick={onReset} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
          <RotateCcw className="h-3 w-3" /> Use Everyone&apos;s value
        </button>
      )}
    </p>
  );
}

/**
 * The input for one setting's value: a switch, a list of its values, a
 * number or a text field. `ariaLabel` names it when the row holds more
 * than this one field.
 */
export function SettingValueInput({ setting, value, onChange, ariaLabel }: {
  setting: PresettableSetting;
  value: unknown;
  onChange: (value: PolicySettingValue) => void;
  ariaLabel?: string;
}) {
  if (setting.type === 'boolean') {
    return <ToggleSwitch checked={value === true} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  if (setting.type === 'enum' && setting.options) {
    const options = setting.options.map((o) => ({ value: String(o.value), label: o.label }));
    // A value from a hand-written policy.json that isn't one of the choices
    // stays visible instead of silently showing another one.
    if (value !== undefined && !setting.options.some((o) => o.value === value)) {
      options.unshift({ value: String(value), label: `${String(value)} (not valid)` });
    }
    return (
      <Select
        value={String(value ?? '')}
        ariaLabel={ariaLabel}
        onChange={(raw) => {
          const option = setting.options!.find((o) => String(o.value) === raw);
          if (option) onChange(option.value);
        }}
        options={options}
      />
    );
  }
  if (setting.type === 'number') {
    return (
      <input
        type="number"
        aria-label={ariaLabel}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => { if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value)); }}
        className={cn(inputClass, 'w-28')}
      />
    );
  }
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      autoComplete="off"
      spellCheck={false}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={cn(inputClass, 'w-full min-w-0 sm:w-64')}
    />
  );
}

function describeRestriction(key: string, r: SettingRestriction | undefined): string {
  if (!r) return 'users choose';
  const parts: string[] = [];
  if (r.locked) parts.push(r.value === undefined ? 'locked, no value' : `locked to ${describeSettingValue(key, r.value)}`);
  if (typeof r.min === 'number') parts.push(`at least ${r.min} seconds`);
  if (r.hidden) parts.push('hidden');
  return parts.length ? parts.join(', ') : 'users choose';
}

function LockRow({ def, policy, scopeId, onChange }: { def: RestrictionKeyDef; policy: SettingsPolicy; scopeId: string; onChange: PolicyChange }) {
  const { value, own, everyone } = restrictionAt(policy, scopeId, def.key);
  const current: SettingRestriction = value ?? {};
  const modes = def.modes ?? ['locked', 'hidden'];
  const setting = presettableSetting(def.key);
  const set = (patch: SettingRestriction) =>
    onChange((p) => withRestrictionAt(p, scopeId, def.key, { ...current, ...patch }));
  const lockTo = () => effectiveDefault(policy, scopeId, def.key) as PolicySettingValue | undefined;

  return (
    <SettingItem label={def.label} description={def.description}>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <div className="flex flex-wrap items-center gap-3">
          {modes.includes('locked') && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="rounded border-input"
                checked={!!current.locked}
                onChange={(e) => set(e.target.checked ? { locked: true, value: current.value ?? lockTo() } : { locked: false })}
              />
              <Lock className="h-3 w-3" /> Lock
            </label>
          )}
          {modes.includes('locked') && current.locked && setting && current.value !== undefined && (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground" aria-hidden="true">Users get</span>
              <SettingValueInput
                setting={setting}
                value={current.value}
                ariaLabel={`Value users get for ${def.label}`}
                onChange={(v) => set({ value: v })}
              />
            </span>
          )}
          {modes.includes('min') && (
            <Select
              value={typeof current.min === 'number' ? String(current.min) : ''}
              ariaLabel={`Minimum for ${def.label}`}
              onChange={(raw) => set({ min: raw === '' ? undefined : Number(raw) })}
              options={[
                { value: '', label: 'No minimum' },
                ...TOAST_MINIMUMS.map((seconds) => ({ value: String(seconds), label: `At least ${seconds} seconds` })),
                ...(typeof current.min === 'number' && !TOAST_MINIMUMS.includes(current.min)
                  ? [{ value: String(current.min), label: `At least ${current.min} seconds` }]
                  : []),
              ]}
            />
          )}
          {modes.includes('hidden') && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="rounded border-input" checked={!!current.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
              Hide
            </label>
          )}
        </div>
        {current.locked && current.value === undefined && (
          // Locks from before the value picker, or from a hand-written
          // policy.json, freeze whatever each user had.
          <p className={cn(noteClass, 'flex flex-wrap items-center gap-1.5')}>
            <span>No value: each user keeps the value they had.</span>
            {lockTo() !== undefined && (
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => set({ value: lockTo() })}>
                Lock to {describeSettingValue(def.key, lockTo())}
              </button>
            )}
          </p>
        )}
        <InheritLine
          scoped={scopeId !== EVERYONE}
          own={own}
          everyone={describeRestriction(def.key, everyone)}
          onReset={() => onChange((p) => withRestrictionAt(p, scopeId, def.key, undefined))}
        />
      </div>
    </SettingItem>
  );
}

/**
 * Lock a setting to a value, set a minimum, or hide it from users' settings.
 * Edits Everyone or the domain or group scope picked at the top.
 */
export function LockedSettingsSection({ policy, onChange }: SectionProps) {
  const [scopeId, setScopeId] = useScopeId(policy);
  const categories = [...new Set(LOCKABLE.map((s) => s.category))];
  return (
    <SettingsSection
      id="restrictions"
      title="Locked settings"
      description="Lock a setting to the value you pick, so users can't change it, or hide it from their settings."
    >
      <ScopePicker policy={policy} scopeId={scopeId} onPick={setScopeId} />
      {categories.map((category) => (
        <div key={category}>
          <p className={subLabelClass}>{category}</p>
          {category === 'Accessibility' && <p className={cn(noteClass, 'mt-1')}>{UNLOCKABLE_NOTE}</p>}
          {LOCKABLE.filter((s) => s.category === category).map((def) => (
            <LockRow key={def.key} def={def} policy={policy} scopeId={scopeId} onChange={onChange} />
          ))}
        </div>
      ))}
    </SettingsSection>
  );
}

function DefaultRow({ setting, policy, scopeId, onChange }: { setting: PresettableSetting; policy: SettingsPolicy; scopeId: string; onChange: PolicyChange }) {
  const preset = defaultAt(policy, scopeId, setting.key);
  const shown = preset.value !== undefined ? preset.value : setting.defaultValue;
  const restriction = restrictionAt(policy, scopeId, setting.key).value;
  const scoped = scopeId !== EVERYONE;
  const set = (value: PolicySettingValue | undefined) => onChange((p) => withDefaultAt(p, scopeId, setting.key, value));

  let conflict: string | null = null;
  if (restriction?.locked && restriction.value !== undefined && isLockableSetting(setting.key)) {
    conflict = `Locked to ${describeSettingValue(setting.key, restriction.value)} above; the lock wins.`;
  } else if (setting.key === 'toastDuration' && typeof restriction?.min === 'number' && typeof shown === 'number'
    && !toastDurationAtLeast(shown, restriction.min)) {
    conflict = `Below the minimum: users get ${restriction.min} seconds.`;
  }

  return (
    <SettingItem
      label={setting.label}
      description={preset.own ? `Built-in: ${describeSettingValue(setting.key, setting.defaultValue)}` : undefined}
    >
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          {preset.own && <Badge tone="accent">set</Badge>}
          <SettingValueInput setting={setting} value={shown} onChange={set} />
          {preset.own && <RevertButton onClick={() => set(undefined)} title={scoped ? "Use Everyone's value" : 'Remove the default'} />}
        </div>
        {scoped && !preset.own && preset.everyone !== undefined && (
          <p className={noteClass}>From Everyone</p>
        )}
        {conflict && <p className="text-xs text-amber-700 dark:text-amber-400">{conflict}</p>}
      </div>
    </SettingItem>
  );
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** Presets for settings the editor has no row for, from policy.json or typed in. */
function OtherDefaults({ policy, scopeId, onChange }: { policy: SettingsPolicy; scopeId: string; onChange: PolicyChange }) {
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keys = otherDefaultKeys(policy, scopeId);
  const defaults = (scopeId === EVERYONE
    ? policy.defaults
    : (policy.scopes ?? []).find((s) => s.id === scopeId)?.policy.defaults) ?? {};

  const add = () => {
    const name = key.trim();
    if (!KEY_RE.test(name)) { setError('Enter the setting\'s key as it appears in a settings export, such as "dateFormat".'); return; }
    if (presettableSetting(name)) { setError('This setting has its own row above.'); return; }
    setError(null);
    onChange((p) => withDefaultAt(p, scopeId, name, parseFreeSettingValue(text)));
    setKey('');
    setText('');
  };

  return (
    <div>
      <p className={subLabelClass}>Other settings</p>
      <p className={cn(noteClass, 'mt-1')}>
        Any other setting from a settings export can get a default by its key. Use true or false for switches, a number, or text.
        A value of the wrong type is ignored by users&apos; browsers.
      </p>
      {keys.map((name) => {
        const value = defaults[name];
        const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'text';
        const setting: PresettableSetting = { key: name, label: name, category: 'Other', type, defaultValue: '' };
        return (
          <SettingItem key={name} label={name}>
            <div className="flex w-full items-center gap-1.5 sm:w-auto">
              <SettingValueInput setting={setting} value={value} onChange={(v) => onChange((p) => withDefaultAt(p, scopeId, name, v))} />
              <RevertButton onClick={() => onChange((p) => withDefaultAt(p, scopeId, name, undefined))} title="Remove the default" />
            </div>
          </SettingItem>
        );
      })}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-[0.6875rem] font-medium text-muted-foreground">Setting key</span>
          <input type="text" value={key} onChange={(e) => setKey(e.target.value)} placeholder="dateFormat" autoComplete="off" spellCheck={false}
            className={cn(inputClass, 'w-48 font-mono')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.6875rem] font-medium text-muted-foreground">Value</span>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="iso" autoComplete="off" spellCheck={false}
            className={cn(inputClass, 'w-40')} />
        </label>
        <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add default
        </Button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Presets: the value each setting starts with for users who haven't
 * changed it themselves. Every option on Settings > Accessibility can be
 * preset here, including the ones that can't be locked.
 */
export function PolicyDefaultsSection({ policy, onChange }: SectionProps) {
  const [scopeId, setScopeId] = useScopeId(policy);
  const categories = [...new Set(PRESETTABLE_SETTINGS.map((s) => s.category))];
  return (
    <SettingsSection
      id="defaults"
      title="Defaults"
      description="The value a setting starts with. It applies to every user who hasn't changed that setting themselves, and they can still change it unless it's locked."
    >
      <ScopePicker policy={policy} scopeId={scopeId} onPick={setScopeId} />
      {categories.map((category) => {
        const settings = PRESETTABLE_SETTINGS.filter((s) => s.category === category);
        const groups = [...new Set(settings.map((s) => s.group ?? ''))];
        return (
          <div key={category} data-testid={`defaults-${category}`}>
            <p className={subLabelClass}>{category}</p>
            {category === 'Accessibility' && (
              <p className={cn(noteClass, 'mt-1')}>
                The options on Settings &gt; Accessibility, in the same order. Only single-key shortcuts, Confirm before sending and a
                minimum notification duration can also be locked.
              </p>
            )}
            {groups.map((name) => (
              <div key={name || category}>
                {name && <p className={groupLabelClass}>{name}</p>}
                {settings.filter((s) => (s.group ?? '') === name).map((setting) => (
                  <DefaultRow key={setting.key} setting={setting} policy={policy} scopeId={scopeId} onChange={onChange} />
                ))}
              </div>
            ))}
          </div>
        );
      })}
      <OtherDefaults policy={policy} scopeId={scopeId} onChange={onChange} />
    </SettingsSection>
  );
}
