'use client';

// Organisation > Proofreading: whether checker plugins may check what users
// write, for everyone or a scope, per checker plugin, and the writing
// language. Requiring proofreading only holds while a checker plugin can't
// be turned off, so the page warns when none is forced on and offers to
// force one (that part is global: plugins can't be forced per scope).

import { useCallback, useEffect, useId, useState } from 'react';
import { SettingItem, SettingsSection, Select } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Trash2 } from '@/components/icons';
import { routing } from '@/i18n/routing';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/browser-navigation';
import type { SettingRestriction } from '@/lib/admin/types';
import {
  PLUGIN_STATES, PROOFREADING_STATES, checkersToForce, pluginProofreadingState, pluginRestrictionFor,
  proofreadingPolicyFor, proofreadingState, type PluginProofreadingState, type ProofreadingState,
} from '@/lib/admin/proofreading-policy';
import { PROOFREADING_KEY, pluginPolicyKey } from '@/lib/proofreading/gate';
import { languageName, writingLanguageOptions } from '@/lib/proofreading/languages';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const LANGUAGE_KEY = 'writingLanguage';
const INHERIT = 'inherit';

interface CheckerPlugin {
  id: string;
  name: string;
  enabled: boolean;
  forceEnabled?: boolean;
  permissions?: string[];
}

/** A default at the selected scope: its own, or Everyone's. */
function presetAt(draft: OrgPolicyDraft, key: string): { value: unknown; own: boolean; everyone: unknown } {
  const everyone = draft.policy?.defaults?.[key];
  if (!draft.scope) return { value: everyone, own: true, everyone };
  const defaults = draft.scope.policy.defaults ?? {};
  return Object.prototype.hasOwnProperty.call(defaults, key)
    ? { value: defaults[key], own: true, everyone }
    : { value: everyone, own: false, everyone };
}

function setPreset(draft: OrgPolicyDraft, key: string, value: unknown | undefined) {
  if (!draft.scope) {
    draft.update((d) => {
      if (value === undefined) delete d.defaults[key];
      else d.defaults[key] = value as never;
    });
    return;
  }
  draft.updateScope(draft.scope.id, (s) => {
    const defaults = (s.policy.defaults ??= {});
    if (value === undefined) delete defaults[key];
    else defaults[key] = value;
    if (Object.keys(defaults).length === 0) delete s.policy.defaults;
  });
}

/** Same cap as the sanitiser. */
const MAX_NOTICE = 4000;

/**
 * The notice users see above the composer when proofreading is on, in the
 * admin's words per language (#1836). Languages without a text keep the
 * built-in notice, which names the checker plugins.
 */
function NoticeEditor({ draft }: { draft: OrgPolicyDraft }) {
  const id = useId();
  const { value, own, everyone } = draft.orgValue('proofreading', 'notice');
  const notice = value ?? {};
  const languages = Object.keys(notice);
  const [shown, setShown] = useState<string | null>(null);
  const current = shown && languages.includes(shown) ? shown : languages[0] ?? null;
  const unused = routing.locales.filter((code) => !languages.includes(code));
  const name = (code: string) => languageName(code, 'en');
  const write = (next: Record<string, string>) => draft.setOrgValue('proofreading', 'notice', next);
  const remove = (code: string) => {
    const next = { ...notice };
    delete next[code];
    write(next);
    setShown(null);
  };
  const everyoneCount = Object.keys(everyone ?? {}).length;

  return (
    <div className="border-b border-border py-3" data-search-label="Notice for users">
      <p className="text-sm font-medium text-foreground">Notice for users</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Shown once above the text when proofreading is on, and in the proofreading panel before a user turns it on, so
        word it for both. Write your own, for example that the text stays on your servers. Languages without a text
        show the built-in notice, which names the proofreading plugin.
      </p>
      <div className="mt-2 flex w-full flex-col items-start gap-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Notice languages">
          {languages.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={code === current}
              onClick={() => setShown(code)}
              className={cn('h-8 rounded-md px-3 text-sm font-medium', code === current ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent')}
            >
              {name(code)}
            </button>
          ))}
          {unused.length > 0 && (
            <select
              aria-label="Add a language"
              data-testid="org-proofreading-notice-add"
              className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm"
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                write({ ...notice, [e.target.value]: '' });
                setShown(e.target.value);
              }}
            >
              <option value="">{languages.length ? 'Add a language…' : 'Write your own…'}</option>
              {unused.map((code) => <option key={code} value={code}>{name(code)}</option>)}
            </select>
          )}
        </div>
        {current && (
          <div className="w-full">
            <label htmlFor={`${id}-text`} className="mb-1 block text-xs font-medium text-foreground">Notice in {name(current)}</label>
            <textarea
              id={`${id}-text`}
              data-testid="org-proofreading-notice-text"
              rows={3}
              dir="auto"
              maxLength={MAX_NOTICE}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-hidden"
              value={notice[current] ?? ''}
              onChange={(e) => write({ ...notice, [current]: e.target.value.slice(0, MAX_NOTICE) })}
            />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {(notice[current] ?? '').trim() ? 'Plain text.' : 'An empty text is not saved; this language keeps the built-in notice.'}
              </p>
              <button type="button" onClick={() => remove(current)} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                <Trash2 className="h-3 w-3" /> Use the built-in notice in {name(current)}
              </button>
            </div>
          </div>
        )}
        <InheritNote
          draft={draft}
          own={own}
          everyone={everyoneCount ? `own notice in ${everyoneCount} ${everyoneCount === 1 ? 'language' : 'languages'}` : 'built-in notice'}
          onReset={() => draft.clearOrgValue('proofreading', 'notice')}
        />
      </div>
    </div>
  );
}

export function ProofreadingSection({ draft }: { draft: OrgPolicyDraft }) {
  const [plugins, setPlugins] = useState<CheckerPlugin[] | null>(null);
  const [forcing, setForcing] = useState<string | null>(null);
  const [forceError, setForceError] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/plugins');
      const list = res.ok ? ((await res.json()) as CheckerPlugin[]) : [];
      setPlugins(list.filter((p) => p.permissions?.includes('compose:check')));
    } catch {
      setPlugins([]);
    }
  }, []);
  useEffect(() => { void loadPlugins(); }, [loadPlugins]);

  const main = draft.restriction(PROOFREADING_KEY);
  const mainPreset = presetAt(draft, PROOFREADING_KEY);
  const mainState = proofreadingState(main.value, mainPreset.value);
  const everyoneState = proofreadingState(main.everyone, mainPreset.everyone);
  const mainOwn = main.own || mainPreset.own;

  const writeMain = (state: ProofreadingState | typeof INHERIT) => {
    if (state === INHERIT) {
      draft.setRestriction(PROOFREADING_KEY, undefined);
      setPreset(draft, PROOFREADING_KEY, undefined);
      return;
    }
    const { restriction, preset } = proofreadingPolicyFor(state);
    // In a scope, "no lock" must undo a lock Everyone has: an empty restriction.
    draft.setRestriction(PROOFREADING_KEY, restriction ?? (draft.scope ? {} : undefined));
    setPreset(draft, PROOFREADING_KEY, preset);
  };

  const pluginStates: Record<string, PluginProofreadingState> = {};
  for (const p of plugins ?? []) pluginStates[p.id] = pluginProofreadingState(draft.restriction(pluginPolicyKey(p.id)).value);
  const toForce = plugins ? checkersToForce(mainState, pluginStates, plugins) : [];

  const force = async (id: string) => {
    setForcing(id);
    setForceError(null);
    try {
      const res = await apiFetch('/api/admin/plugins', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: true, forceEnabled: true }),
      });
      if (!res.ok) setForceError('Could not force the plugin on. Try it on its page under Plugins.');
      await loadPlugins();
    } finally {
      setForcing(null);
    }
  };

  const language = draft.restriction(LANGUAGE_KEY);
  const languagePreset = presetAt(draft, LANGUAGE_KEY);
  const languageValue = (language.value?.locked ? language.value.value : languagePreset.value) as string | undefined;
  const languageLocked = language.value?.locked === true;
  const writeLanguage = (value: string, locked: boolean) => {
    if (!value) {
      draft.setRestriction(LANGUAGE_KEY, draft.scope ? {} : undefined);
      setPreset(draft, LANGUAGE_KEY, undefined);
      return;
    }
    draft.setRestriction(LANGUAGE_KEY, locked ? { locked: true, value } as SettingRestriction : (draft.scope ? {} : undefined));
    setPreset(draft, LANGUAGE_KEY, value);
  };

  const stateLabel = (s: ProofreadingState) => PROOFREADING_STATES.find((o) => o.value === s)?.label ?? s;

  return (
    <SettingsSection
      id="proofreading"
      title="Proofreading"
      description="Proofreading plugins underline spelling and grammar mistakes while users write. The text users write (not their signature or quoted messages) goes to the service the plugin uses. Nothing is sent while a message is set to be signed or encrypted, also when proofreading is required; text written before the user turned that on may already have been checked."
    >
      <SettingItem label="Proofreading" description="Off and locked hides the setting. On and required keeps it on in every composer.">
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Select
            value={draft.scope && !mainOwn ? INHERIT : mainState}
            onChange={(v) => writeMain(v as ProofreadingState | typeof INHERIT)}
            options={[
              ...(draft.scope ? [{ value: INHERIT, label: `Same as Everyone (${stateLabel(everyoneState)})` }] : []),
              ...PROOFREADING_STATES.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
          <InheritNote draft={draft} own={mainOwn} everyone={stateLabel(everyoneState)} onReset={() => writeMain(INHERIT)} />
        </div>
      </SettingItem>

      {plugins && plugins.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No proofreading plugin is installed. Install one, such as Proofreading (LanguageTool), under Marketplace or Plugins.
        </p>
      )}

      {plugins?.map((p) => {
        const r = draft.restriction(pluginPolicyKey(p.id));
        const state = pluginProofreadingState(r.value);
        return (
          <SettingItem key={p.id} nested label={p.name} description={p.enabled ? undefined : 'Turned off under Plugins: it checks nothing.'}>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <Select
                value={draft.scope && !r.own ? INHERIT : state}
                onChange={(v) => draft.setRestriction(
                  pluginPolicyKey(p.id),
                  v === INHERIT ? undefined : pluginRestrictionFor(v as PluginProofreadingState) ?? (draft.scope ? {} : undefined),
                )}
                options={[
                  ...(draft.scope ? [{ value: INHERIT, label: 'Same as Everyone' }] : []),
                  ...PLUGIN_STATES.map((o) => ({ value: o.value, label: o.label })),
                ]}
                ariaLabel={`Proofreading with ${p.name}`}
              />
            </div>
          </SettingItem>
        );
      })}

      {toForce.length > 0 && (
        <div role="status" data-testid="proofreading-force-warning" className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Proofreading is required, but no proofreading plugin is forced on, so users can turn the plugin off under
              Settings &gt; Add-ons and the check with it. Forcing a plugin on applies to everyone, not only this scope.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {toForce.map((id) => {
              const p = plugins!.find((x) => x.id === id)!;
              return (
                <Button key={id} variant="outline" size="xs" disabled={forcing !== null} onClick={() => void force(id)}>
                  Force {p.name} on for everyone
                </Button>
              );
            })}
          </div>
          {forceError && <p className="text-xs text-destructive">{forceError}</p>}
        </div>
      )}

      <NoticeEditor draft={draft} />

      <SettingItem label="Writing language" description="Presets the language users write in; proofreading and the browser's spell check use it. Locked, users can't change it.">
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={languageValue ?? ''}
              onChange={(v) => writeLanguage(v, languageLocked)}
              options={[{ value: '', label: 'Users choose' }, { value: 'auto', label: 'Detect automatically' }, ...writingLanguageOptions('en')]}
              ariaLabel="Writing language"
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="rounded border-input"
                checked={languageLocked}
                disabled={!languageValue}
                onChange={(e) => writeLanguage(languageValue ?? '', e.target.checked)}
              />
              Lock
            </label>
          </div>
        </div>
      </SettingItem>

      <p className="text-xs text-muted-foreground">
        For a fully mandatory setup: force the plugin on, set Proofreading to &quot;On, required&quot; and, in the plugin&apos;s
        settings, turn off users changing its language and rules. A plugin that reaches a server on your network needs that
        address in PLUGIN_PROXY_PRIVATE_ORIGINS.
      </p>
    </SettingsSection>
  );
}
