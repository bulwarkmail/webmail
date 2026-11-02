'use client';

// Organisation > Proofreading: whether checker plugins may check what users
// write, for everyone or a scope, per checker plugin, and the writing
// language. Requiring proofreading only holds while a checker plugin can't
// be turned off, so the page warns when none is forced on and offers to
// force one (that part is global: plugins can't be forced per scope).

import { useCallback, useEffect, useState } from 'react';
import { SettingItem, SettingsSection, Select } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import type { SettingRestriction } from '@/lib/admin/types';
import {
  PLUGIN_STATES, PROOFREADING_STATES, checkersToForce, pluginProofreadingState, pluginRestrictionFor,
  proofreadingPolicyFor, proofreadingState, type PluginProofreadingState, type ProofreadingState,
} from '@/lib/admin/proofreading-policy';
import { PROOFREADING_KEY, pluginPolicyKey } from '@/lib/proofreading/gate';
import { writingLanguageOptions } from '@/lib/proofreading/languages';
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
