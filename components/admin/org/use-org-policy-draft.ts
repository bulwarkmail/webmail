'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { FeatureGates, SettingRestriction, SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import {
  DEFAULT_ORGANISATION_POLICY,
  sanitizeOrganisationPolicy,
  type OrganisationPolicy,
  type OrganisationSection,
} from '@/lib/admin/organisation-policy';
import type { PolicyScope } from '@/lib/admin/policy-scopes';
import { apiFetch } from '@/lib/browser-navigation';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { useAdminFeedback } from '@/components/admin/feedback';

/** The scope id the Organisation pages edit; '' is Everyone (the global policy). */
export const EVERYONE = '';

/** The scope picked on one Organisation page stays picked on the others. */
export const useOrgScopeStore = create<{ scopeId: string; setScopeId: (id: string) => void }>()((set) => ({
  scopeId: EVERYONE,
  setScopeId: (scopeId) => set({ scopeId }),
}));

type SectionValues<S extends OrganisationSection> = OrganisationPolicy[S];

export interface OrgValue<T> {
  /** What applies at the selected scope: its own value, or the inherited one. */
  value: T;
  /** The selected scope sets it itself (always true for Everyone). */
  own: boolean;
  /** Everyone's value, shown as "From Everyone" in a scope. */
  everyone: T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Loading, editing and saving the user policy for one Organisation page.
 * Edits go to the scope chosen in the scope bar (Everyone or one domain or
 * group scope); in a scope, a value the scope doesn't set shows Everyone's
 * and can be reset to it. Saving writes the whole policy, so the User
 * policy page and every Organisation page work on the same policy.json.
 */
export function useOrgPolicyDraft(dirtyId: string) {
  const [policy, setPolicy] = useState<SettingsPolicy | null>(null);
  const [saved, setSaved] = useState<SettingsPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  // The version of the policy this draft started from: a save based on an
  // older one is refused instead of undoing someone else's change.
  const policyETag = useRef<string | null>(null);
  // Outcomes show in a toast, like every admin page's.
  const setMessage = useAdminFeedback();
  const scopeId = useOrgScopeStore((s) => s.scopeId);
  const setScopeId = useOrgScopeStore((s) => s.setScopeId);

  /** Start editing from `data`, the policy stored at version `etag`. */
  const adopt = useCallback((data: SettingsPolicy, etag: string | null) => {
    policyETag.current = etag;
    const normalised = { ...DEFAULT_POLICY, ...data, organisation: sanitizeOrganisationPolicy(data.organisation), scopes: data.scopes ?? [] };
    setPolicy(normalised);
    setSaved(clone(normalised));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/policy');
      if (!res.ok) throw new Error();
      adopt((await res.json()) as SettingsPolicy, res.headers.get('ETag'));
    } catch {
      setMessage({ type: 'error', text: 'Could not load the policy' });
      setPolicy((p) => p ?? { ...DEFAULT_POLICY, organisation: clone(DEFAULT_ORGANISATION_POLICY), scopes: [] });
    }
  }, [adopt, setMessage]);

  useEffect(() => { void load(); }, [load]);

  const scopes = useMemo(() => policy?.scopes ?? [], [policy]);
  const scope = scopes.find((s) => s.id === scopeId) ?? null;
  // A scope deleted elsewhere (or on another page) falls back to Everyone.
  useEffect(() => {
    if (policy && scopeId !== EVERYONE && !scope) setScopeId(EVERYONE);
  }, [policy, scopeId, scope, setScopeId]);

  const dirty = !!policy && !!saved && JSON.stringify(policy) !== JSON.stringify(saved);
  useAdminUnsavedChanges(dirtyId, dirty);

  const update = useCallback((change: (draft: SettingsPolicy) => void) => {
    setPolicy((current) => {
      if (!current) return current;
      const draft = clone(current);
      change(draft);
      return draft;
    });
    setMessage(null);
  }, [setMessage]);

  const updateScope = useCallback((id: string, change: (scope: PolicyScope) => void) => {
    update((draft) => {
      const target = draft.scopes?.find((s) => s.id === id);
      if (target) change(target);
    });
  }, [update]);

  const org = policy?.organisation ?? DEFAULT_ORGANISATION_POLICY;

  function orgValue<S extends OrganisationSection, K extends keyof SectionValues<S>>(section: S, key: K): OrgValue<SectionValues<S>[K]> {
    const everyone = org[section][key];
    if (!scope) return { value: everyone, own: true, everyone };
    const override = (scope.policy.organisation?.[section] as Partial<SectionValues<S>> | undefined)?.[key];
    return override === undefined
      ? { value: everyone, own: false, everyone }
      : { value: override as SectionValues<S>[K], own: true, everyone };
  }

  function setOrgValue<S extends OrganisationSection, K extends keyof SectionValues<S>>(section: S, key: K, value: SectionValues<S>[K]) {
    if (!scope) {
      update((draft) => {
        const target = (draft.organisation ?? clone(DEFAULT_ORGANISATION_POLICY)) as OrganisationPolicy;
        (target[section] as SectionValues<S>)[key] = value;
        draft.organisation = target;
      });
      return;
    }
    updateScope(scope.id, (s) => {
      const organisation = (s.policy.organisation ??= {}) as Record<string, Record<string, unknown>>;
      (organisation[section] ??= {})[key as string] = value;
    });
  }

  /** In a scope: use Everyone's value again. */
  function clearOrgValue<S extends OrganisationSection>(section: S, key: keyof SectionValues<S>) {
    if (!scope) return;
    updateScope(scope.id, (s) => {
      const values = s.policy.organisation?.[section] as Record<string, unknown> | undefined;
      if (!values) return;
      delete values[key as string];
      if (Object.keys(values).length === 0) delete (s.policy.organisation as Record<string, unknown>)[section];
    });
  }

  function restriction(key: string): OrgValue<SettingRestriction | undefined> {
    const everyone = policy?.restrictions[key];
    if (!scope) return { value: everyone, own: true, everyone };
    const override = scope.policy.restrictions?.[key];
    return override === undefined ? { value: everyone, own: false, everyone } : { value: override, own: true, everyone };
  }

  /** Sets the restriction at the selected scope; undefined removes it (in a scope: inherit). */
  function setRestriction(key: string, value: SettingRestriction | undefined) {
    const empty = !value || (!value.locked && !value.hidden && !value.allowedValues?.length && value.min === undefined && value.max === undefined);
    if (!scope) {
      update((draft) => {
        if (empty) delete draft.restrictions[key];
        else draft.restrictions[key] = value!;
      });
      return;
    }
    updateScope(scope.id, (s) => {
      const restrictions = (s.policy.restrictions ??= {});
      // In a scope, "nothing" is a real override: it unlocks what Everyone locks.
      if (value === undefined) delete restrictions[key];
      else restrictions[key] = empty ? {} : value;
    });
  }

  function feature(key: keyof FeatureGates): OrgValue<boolean> {
    const everyone = policy?.features[key] ?? DEFAULT_POLICY.features[key];
    if (!scope) return { value: everyone, own: true, everyone };
    const override = scope.policy.features?.[key];
    return override === undefined ? { value: everyone, own: false, everyone } : { value: override, own: true, everyone };
  }

  function setFeature(key: keyof FeatureGates, value: boolean | undefined) {
    if (!scope) {
      update((draft) => { draft.features[key] = value ?? DEFAULT_POLICY.features[key]; });
      return;
    }
    updateScope(scope.id, (s) => {
      const features = (s.policy.features ??= {});
      if (value === undefined) delete features[key];
      else features[key] = value;
    });
  }

  async function save() {
    if (!policy) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(policyETag.current ? { 'If-Match': policyETag.current } : {}) },
        body: JSON.stringify(policy),
      });
      if (res.ok) {
        // The server sanitises; show what it kept. From the answer, not a new
        // read, which another instance might serve before it has the change.
        const stored = ((await res.json().catch(() => null)) as { policy?: SettingsPolicy } | null)?.policy;
        if (stored) adopt(stored, res.headers.get('ETag'));
        else await load();
        setMessage({ type: 'success', text: 'Saved. Users get the change the next time Bulwark loads.' });
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error || 'Could not save the policy' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Could not save the policy' });
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (saved) setPolicy(clone(saved));
    setMessage(null);
  }

  return {
    policy,
    loading: policy === null,
    scopes,
    scope,
    scopeId: scope ? scope.id : EVERYONE,
    setScopeId,
    update,
    updateScope,
    orgValue,
    setOrgValue,
    clearOrgValue,
    restriction,
    setRestriction,
    feature,
    setFeature,
    dirty,
    saving,
    save,
    discard,
    setMessage,
    reload: load,
  };
}

export type OrgPolicyDraft = ReturnType<typeof useOrgPolicyDraft>;
