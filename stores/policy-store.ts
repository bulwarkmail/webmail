import { create } from 'zustand';
import type { SettingsPolicy, FeatureGates, SettingRestriction, ThemePolicy, ColorMode } from '@/lib/admin/types';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY, POLICY_DOMAINS_HEADER, POLICY_SCOPE_HEADER } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE, IS_LITE_STALWART, LITE_POLICY_PATH, withLiteBuildId } from '@/lib/lite';
import { applyLitePolicy } from '@/lib/lite-config';
import { configureErrorReporting } from '@/lib/error-reporting/client';
import { liteErrorReporting } from '@/lib/error-reporting/lite';
import { resolvePolicy, type PolicySource, type PolicySubject } from '@/lib/admin/policy-scopes';
import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from '@/lib/admin/organisation-policy';

interface PolicyState {
  /**
   * The effective policy for the active account: the policy as fetched with
   * the domain and group scopes that match the account applied. Everything
   * that reads the policy reads this.
   */
  policy: SettingsPolicy;
  /** The policy as fetched, scopes included. */
  rawPolicy: SettingsPolicy;
  /** The account `policy` was resolved for; null before one is known. */
  subject: PolicySubject | null;
  /**
   * The active account's subject is being worked out (signed in, its groups
   * not known yet). Until it is, a group scope's lock may not be applied yet.
   */
  subjectPending: boolean;
  setSubjectPending: (pending: boolean) => void;
  /** Ids of the scopes that apply to `subject`. */
  matchedScopes: string[];
  /** What set each non-default value of `policy` (see ResolvedPolicy.sources). */
  sources: Record<string, PolicySource>;
  /**
   * The domains the server picked the scopes for, or null when it sent all
   * of them. An account of another domain needs a fresh fetch.
   */
  scopeDomains: string[] | null;
  /** Whether the fetched scopes cover this address's domain. */
  coversAddress: (email: string) => boolean;
  loaded: boolean;
  /**
   * A policy fetch is on its way. While it is and nothing has loaded yet,
   * things the policy may lock fail closed (hooks/use-third-party-mode.ts).
   */
  fetching: boolean;
  /**
   * Where `rawPolicy` came from: the server, the copy of the last fetched
   * policy kept in this browser (the fetch failed), or the built-in
   * defaults (nothing was ever fetched). A loaded server policy is never
   * replaced by the copy or the defaults, so a network blip can't lift the
   * organisation's locks.
   */
  source: 'none' | 'server' | 'cache' | 'fallback';
  /**
   * The server answered with the public subset (not signed in yet); the
   * full policy is fetched again once a session exists.
   */
  partial: boolean;
  /**
   * Gates the demo switches on regardless of the deployment's policy, so the
   * demo's two accounts and shared mailbox can show the merged views. Set by
   * the demo login only; empty everywhere else.
   */
  demoFeatureOverrides: Partial<FeatureGates>;
  setDemoFeatureOverrides: (overrides: Partial<FeatureGates>) => void;
  fetchPolicy: () => Promise<void>;
  /** Resolve the policy for this account (the active one); null for none. */
  setPolicySubject: (subject: PolicySubject | null) => void;
  /** The effective policy of another account, without making it the active one. */
  resolveFor: (subject: PolicySubject | null) => SettingsPolicy;
  /** The organisation settings of the effective policy. */
  getOrganisation: () => OrganisationPolicy;
  /** `global`, a scope id, or `default` when nothing set it. */
  getPolicySource: (key: string) => PolicySource;
  /** Fetch the full policy if only the public subset is loaded. */
  refreshIfPartial: () => Promise<void>;
  isSettingLocked: (key: string) => boolean;
  isSettingHidden: (key: string) => boolean;
  isFeatureEnabled: (feature: keyof FeatureGates) => boolean;
  getRestriction: (key: string) => SettingRestriction | undefined;
  getEffectiveDefault: (key: string) => unknown;
  getThemePolicy: () => ThemePolicy;
  /**
   * The theme policy's color mode (#1280): `mode` for users who have not
   * picked one, and for everyone while `locked`. A lock without a valid
   * defaultColorMode pins the built-in default, system.
   */
  getColorModePolicy: () => { mode: ColorMode | null; locked: boolean };
  getForcedThemeId: (availableThemeIds?: string[]) => string | null;
  isThemeDisabled: (themeId: string, isBuiltIn: boolean) => boolean;
  isPluginForceEnabled: (pluginId: string) => boolean;
  isThemeForceEnabled: (themeId: string) => boolean;
}

let policyRequest = 0;
/** The body of the last server answer that landed. */
let lastServerJson: string | null = null;

/**
 * The last full policy the server sent, kept so a failed fetch (network
 * down, a refetch that errors) doesn't fall back to the defaults and lift
 * every lock. Removed at full sign-out (lib/sign-out-cleanup.ts).
 */
export const POLICY_CACHE_KEY = 'bulwark-policy-last';

function readCachedPolicy(): Record<string, unknown> | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(POLICY_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedPolicy(data: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (data && typeof data === 'object') localStorage.setItem(POLICY_CACHE_KEY, JSON.stringify(data));
    else localStorage.removeItem(POLICY_CACHE_KEY);
  } catch {
    // Storage full or blocked: the in-memory policy still applies.
  }
}

/**
 * Resolves once the first policy fetch has settled (or after `timeoutMs`).
 * Sending waits for it, so a required label or a send check the policy
 * turns on can't be skipped by sending in the first moment after load.
 */
export async function whenPolicySettled(timeoutMs = 5000): Promise<void> {
  const settled = () => {
    const { fetching, loaded } = usePolicyStore.getState();
    return loaded || !fetching;
  };
  if (settled()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { unsubscribe(); resolve(); }, timeoutMs);
    const unsubscribe = usePolicyStore.subscribe(() => {
      if (!settled()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

const COLOR_MODES: readonly ColorMode[] = ['light', 'dark', 'system'];

const sameSubject = (a: PolicySubject | null, b: PolicySubject | null) =>
  a === b || (!!a && !!b && a.email === b.email && a.groups.join(',') === b.groups.join(','));

function resolved(rawPolicy: SettingsPolicy, subject: PolicySubject | null) {
  const { policy, matched, sources } = resolvePolicy(rawPolicy, subject);
  return { rawPolicy, policy, matchedScopes: matched, sources };
}

const INITIAL = resolved({ ...DEFAULT_POLICY }, null);

export const usePolicyStore = create<PolicyState>()((set, get) => ({
  ...INITIAL,
  subject: null,
  subjectPending: false,
  scopeDomains: null,
  loaded: false,
  fetching: false,
  source: 'none',
  partial: false,
  demoFeatureOverrides: {},

  setDemoFeatureOverrides: (overrides) => set({ demoFeatureOverrides: overrides }),

  fetchPolicy: async () => {
    // A fetch started before signing in may answer after the one started
    // after it; only the latest may land.
    const request = ++policyRequest;
    set({ fetching: true });
    // Static Lite build: an optional policy.json next to index.html stands in
    // for the admin server; missing means defaults, and the gates that need
    // the server stay pinned off either way (lib/lite-config.ts).
    const fallback = IS_LITE ? { policy: applyLitePolicy({}) } : {};
    // The fetch failed: keep a policy the server already gave, else the last
    // one this browser saw, else the defaults.
    const settleWithoutServer = () => {
      if (get().source === 'server') {
        set({ loaded: true });
        return;
      }
      const cached = readCachedPolicy();
      if (cached) {
        set({ ...resolved(IS_LITE ? applyLitePolicy(cached) : (cached as unknown as SettingsPolicy), get().subject), loaded: true, source: 'cache' });
      } else {
        set({ ...(fallback.policy ? resolved(fallback.policy, get().subject) : {}), loaded: true, source: 'fallback' });
      }
    };
    try {
      // Stalwart serves bundle files immutably: a build-id URL instead of no-store.
      const res = IS_LITE_STALWART
        ? await apiFetch(withLiteBuildId(LITE_POLICY_PATH))
        : await apiFetch(IS_LITE ? LITE_POLICY_PATH : '/api/admin/policy', IS_LITE ? { cache: 'no-store' } : undefined);
      if (request !== policyRequest) return;
      if (res.ok) {
        const data = await res.json();
        if (request !== policyRequest) return;
        const partial = res.headers?.get?.(POLICY_SCOPE_HEADER) === 'public';
        const domainsHeader = res.headers?.get?.(POLICY_DOMAINS_HEADER);
        const scopeDomains = typeof domainsHeader === 'string' ? domainsHeader.split(',').filter(Boolean) : null;
        // Lite has no /api/config: error reporting is set in policy.json.
        if (IS_LITE) configureErrorReporting(liteErrorReporting(data));
        // A refetch that brings nothing new (the periodic one, hooks/use-policy-refresh.ts)
        // keeps the resolved objects, so nothing that reads the policy re-runs.
        const json = JSON.stringify(data);
        const current = get();
        if (current.source === 'server' && lastServerJson === json && current.partial === partial
          && (current.scopeDomains ?? []).join(',') === (scopeDomains ?? []).join(',')) {
          set({ loaded: true });
          return;
        }
        lastServerJson = json;
        set({ ...resolved(IS_LITE ? applyLitePolicy(data) : data, get().subject), loaded: true, source: 'server', partial, scopeDomains });
        if (!partial) writeCachedPolicy(data);
      } else if (IS_LITE && res.status === 404) {
        // No policy.json: the deployment set nothing, which is an answer.
        if (IS_LITE) configureErrorReporting(null);
        set({ ...(fallback.policy ? resolved(fallback.policy, get().subject) : {}), loaded: true, source: 'server' });
        writeCachedPolicy(null);
      } else {
        if (IS_LITE) configureErrorReporting(null);
        settleWithoutServer();
      }
    } catch {
      if (IS_LITE && request === policyRequest) configureErrorReporting(null);
      if (request === policyRequest) settleWithoutServer();
    } finally {
      if (request === policyRequest) set({ fetching: false });
    }
  },

  setSubjectPending: (pending) => { if (get().subjectPending !== pending) set({ subjectPending: pending }); },

  setPolicySubject: (subject) => {
    if (get().subjectPending) set({ subjectPending: false });
    if (sameSubject(subject, get().subject)) return;
    set({ ...resolved(get().rawPolicy, subject), subject });
  },

  resolveFor: (subject) => resolvePolicy(get().rawPolicy, subject).policy,

  coversAddress: (email) => {
    const domains = get().scopeDomains;
    if (!domains) return true;
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    return domains.includes(domain);
  },

  getOrganisation: () => get().policy.organisation ?? DEFAULT_ORGANISATION_POLICY,

  getPolicySource: (key) => get().sources[key] ?? 'default',

  refreshIfPartial: async () => {
    if (IS_LITE || (get().loaded && !get().partial)) return;
    await get().fetchPolicy();
  },

  isSettingLocked: (key) => {
    const r = get().policy.restrictions[key];
    return r?.locked === true;
  },

  isSettingHidden: (key) => {
    const r = get().policy.restrictions[key];
    return r?.hidden === true;
  },

  isFeatureEnabled: (feature) => {
    const override = get().demoFeatureOverrides[feature];
    if (override !== undefined) return override;
    return get().policy.features[feature] ?? true;
  },

  getRestriction: (key) => {
    return get().policy.restrictions[key];
  },

  getEffectiveDefault: (key) => {
    return get().policy.defaults[key];
  },

  getThemePolicy: () => {
    return get().policy.themePolicy || { ...DEFAULT_THEME_POLICY };
  },

  getColorModePolicy: () => {
    const tp = get().policy.themePolicy || DEFAULT_THEME_POLICY;
    // policy.json is written by hand: anything but the three modes is no default.
    const mode = COLOR_MODES.find((m) => m === tp.defaultColorMode) ?? null;
    const locked = tp.lockColorMode === true;
    return { mode: locked ? mode ?? 'system' : mode, locked };
  },

  getForcedThemeId: (availableThemeIds) => {
    const forceEnabledThemes = get().policy.forceEnabledThemes || [];
    if (!availableThemeIds || availableThemeIds.length === 0) {
      return forceEnabledThemes[0] || null;
    }

    const available = new Set(availableThemeIds);
    return forceEnabledThemes.find((themeId) => available.has(themeId)) || null;
  },

  isThemeDisabled: (themeId, isBuiltIn) => {
    const tp = get().policy.themePolicy || DEFAULT_THEME_POLICY;
    if (isBuiltIn) {
      return (tp.disabledBuiltinThemes || []).includes(themeId);
    }
    return (tp.disabledThemes || []).includes(themeId);
  },

  isPluginForceEnabled: (pluginId) => {
    return (get().policy.forceEnabledPlugins || []).includes(pluginId);
  },

  isThemeForceEnabled: (themeId) => {
    return (get().policy.forceEnabledThemes || []).includes(themeId);
  },
}));
