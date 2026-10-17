import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FilterRule, SieveCapabilities, VacationAudience, VacationForward, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { parseScript } from '@/lib/sieve/parser';
import { FILTERS_SCRIPT_NAME, generateScript, supportsSpamGuard, VACATION_SCRIPT_NAME } from '@/lib/sieve/generator';
import {
  OpaqueFiltersError, applyScriptTransforms, assertFiltersSaveAllowed, filterRuleToView, readAccountFilters, renderFiltersScript,
  supportsInclude, writeFiltersScript,
} from '@/lib/filters/account-filters';
import { countKeywordUses, renameKeywordInRules } from '@/lib/sieve/keyword-rename';
import { filterHooks } from '@/lib/plugin-hooks';
import { worstCaseForwards } from '@/lib/filters/forward-limit';
import { supportsPeriods } from '@/lib/sieve/period';
import { isValidVacationForward, withVacationPeriod } from '@/lib/sieve/vacation-forward';
import { isValidVacationAudience, normalizeVacationAudience } from '@/lib/sieve/vacation-audience';
import { debug } from '@/lib/debug';

/** What a tag rename managed to do to the filters that name the tag. */
export interface KeywordRenameOutcome {
  /** Filter actions rewritten to the new tag id. */
  changed: number;
  /**
   * References to the old tag left in place because the script is hand-edited
   * and is kept verbatim. The caller should tell the user, who has to fix those
   * by hand - nothing else will.
   */
  unhandled: number;
}

interface SieveAccount {
  id: string;
  name: string;
  isPrimary: boolean;
}

function emitFiltersLoaded(rules: FilterRule[]): void {
  if (filterHooks.onFiltersLoaded.size > 0) void filterHooks.onFiltersLoaded.emit(rules.map(filterRuleToView));
}

type RuleChange = 'added' | 'updated' | 'deleted' | 'reordered' | 'toggled';

function emitRuleChange(ruleId: string, change: RuleChange): void {
  void filterHooks.onFilterRuleChange.emit({ ruleId, change });
}

/** Rules from other clients and hand-edited scripts are read-only here. */
function isEditableRule(rules: FilterRule[], ruleId: string): boolean {
  const rule = rules.find(r => r.id === ruleId);
  return !!rule && rule.origin !== 'external' && rule.origin !== 'opaque';
}

interface FilterStore {
  rules: FilterRule[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;
  sieveCapabilities: SieveCapabilities | null;
  activeScriptId: string | null;
  isOpaque: boolean;
  rawScript: string;
  vacationSettings: VacationSieveConfig | null;
  externalRequires: string[];
  includeVacation: boolean;
  /** Forwarding from the vacation card; carried through every save. */
  vacationForward: VacationForward | null;
  /** Who gets the auto-reply, when not everyone; carried through every save. */
  vacationAudience: VacationAudience | null;
  /** The host's server rules region (lib/sieve/server-rules); carried through every save. */
  serverRules: string;
  availableAccounts: SieveAccount[];
  selectedAccountId: string | null;

  setSupported: (supported: boolean) => void;
  fetchFilters: (client: IJMAPClient, accountId?: string) => Promise<void>;
  selectAccount: (client: IJMAPClient, accountId: string) => Promise<void>;
  saveFilters: (client: IJMAPClient) => Promise<void>;
  renameKeywordInFilters: (client: IJMAPClient, oldId: string, newId: string) => Promise<KeywordRenameOutcome>;
  validateScript: (client: IJMAPClient, content: string) => Promise<{ isValid: boolean; errors?: string[] }>;
  addRule: (rule: FilterRule) => void;
  updateRule: (ruleId: string, updates: Partial<FilterRule>) => void;
  deleteRule: (ruleId: string) => void;
  reorderRules: (ruleIds: string[]) => void;
  toggleRule: (ruleId: string) => void;
  setRawScript: (content: string) => void;
  resetToVisualBuilder: () => void;
  clearState: () => void;
}

/**
 * Bumped by every fetch, account selection and reset. A fetch that is no
 * longer the latest when its answer arrives drops it: an account switch
 * during the fetch would otherwise leave one account's rules and script id
 * in place for the next account, and the next save would upload them there.
 */
let fetchGeneration = 0;

export const useFilterStore = create<FilterStore>()((set, get) => ({
  rules: [],
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,
  sieveCapabilities: null,
  activeScriptId: null,
  isOpaque: false,
  rawScript: '',
  vacationSettings: null,
  externalRequires: [],
  includeVacation: false,
  vacationForward: null,
  vacationAudience: null,
  serverRules: '',
  availableAccounts: [],
  selectedAccountId: null,

  setSupported: (supported) => set({ isSupported: supported }),

  fetchFilters: async (client, accountId) => {
    const generation = ++fetchGeneration;
    const stale = () => generation !== fetchGeneration;
    set({ isLoading: true, error: null });
    try {
      const accounts = client.getSieveAccounts();
      const resolvedId =
        accountId || get().selectedAccountId || client.getSieveAccountId();
      set({ availableAccounts: accounts, selectedAccountId: resolvedId });

      const capabilities = client.getSieveCapabilities(resolvedId);
      set({ sieveCapabilities: capabilities });

      const allScripts = await client.getSieveScripts(resolvedId);
      if (stale()) return;
      debug.log('filters', 'Sieve scripts fetched:', allScripts.length);

      // Skip the server-managed 'vacation' script (RFC 9661 §4) - it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter(s => s.name !== VACATION_SCRIPT_NAME);

      // Saving activates the filters script, which switches off an active
      // server vacation script. Include it instead so both keep working.
      const vacationActive =
        allScripts.some(s => s.name === VACATION_SCRIPT_NAME && s.isActive) &&
        supportsInclude(capabilities);

      const activeScript = scripts.find(s => s.isActive) || scripts.find(s => s.name === FILTERS_SCRIPT_NAME) || scripts[0];
      if (!activeScript) {
        emitFiltersLoaded([]);
        set({
          isLoading: false,
          rules: [],
          activeScriptId: null,
          rawScript: '',
          isOpaque: false,
          includeVacation: vacationActive,
          vacationForward: null,
          vacationAudience: null,
          serverRules: '',
        });
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await client.getSieveScriptContent(activeScript.blobId, resolvedId);
      if (stale()) return;
      set({ rawScript: content });

      const result = parseScript(content);

      if (result.isOpaque) {
        debug.log('filters', 'Sieve script is opaque (hand-edited)');
        emitFiltersLoaded([]);
        set({
          isLoading: false,
          isOpaque: true,
          rules: [],
          vacationSettings: result.vacation || null,
          externalRequires: result.externalRequires,
          includeVacation: false,
          vacationForward: null,
          vacationAudience: null,
          serverRules: '',
        });
      } else {
        debug.log('filters', 'Parsed', result.rules.length, 'filter rules');
        emitFiltersLoaded(result.rules);
        set({
          isLoading: false,
          isOpaque: false,
          rules: result.rules,
          vacationSettings: result.vacation || null,
          externalRequires: result.externalRequires,
          includeVacation: !!result.includeVacation || vacationActive,
          vacationForward: result.vacationForward ?? null,
          vacationAudience: result.vacationAudience ?? null,
          serverRules: result.serverRules ?? '',
        });
      }
    } catch (error) {
      if (stale()) return;
      debug.error('Failed to fetch filters:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch filters',
      });
    }
  },

  selectAccount: async (client, accountId) => {
    // Reset parsed state so one account's rules/script never leak into another
    // before the re-fetch populates the new account's data.
    set({
      selectedAccountId: accountId,
      rules: [],
      rawScript: '',
      activeScriptId: null,
      isOpaque: false,
      vacationSettings: null,
      externalRequires: [],
      includeVacation: false,
      vacationForward: null,
      vacationAudience: null,
      serverRules: '',
    });
    await get().fetchFilters(client, accountId);
  },

  saveFilters: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, includeVacation,
        vacationForward, vacationAudience, selectedAccountId, sieveCapabilities, serverRules,
      } = get();
      // Throws FiltersSaveVetoedError (handled below like any failed save,
      // so the settings UI puts its optimistic change back).
      await assertFiltersSaveAllowed(rules);

      let content: string;
      if (isOpaque) {
        content = rawScript;
      } else {
        content = generateScript(rules, vacationSettings || undefined, {
          externalRequires,
          includeVacation,
          vacationForward,
          vacationAudience,
          extensions: sieveCapabilities?.sieveExtensions,
          serverRules,
        });
      }
      const written = await writeFiltersScript(client, selectedAccountId || null, content, activeScriptId);
      if (!activeScriptId) set({ activeScriptId: written.scriptId });

      set({ isSaving: false, rawScript: written.content });
      debug.log('filters', 'Filters saved successfully');
    } catch (error) {
      debug.error('Failed to save filters:', error);
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save filters',
      });
      throw error;
    }
  },

  /**
   * Follows a renamed tag into this account's filters.
   *
   * Renaming a tag changes its id, and therefore the `$label:` keyword a rule
   * writes. Migrating only the messages (`migrateKeyword`) would leave the rule
   * tagging new mail under the old id, which nothing names any more - the rule
   * looks broken while running exactly as written.
   *
   * The script is fetched and written back on its own rather than through
   * `fetchFilters`/`saveFilters`, so a rename from the tag settings never
   * disturbs which account an open filter view is showing. That view is updated
   * in place when it happens to be showing this same account.
   *
   * A hand-edited (opaque) script is left alone - it has no parsed rules to
   * rewrite and re-generating it would discard the user's own Sieve - and its
   * remaining references are reported instead. Upload failures propagate.
   */
  renameKeywordInFilters: async (client, oldId, newId) => {
    const nothing: KeywordRenameOutcome = { changed: 0, unhandled: 0 };
    if (!oldId || !newId || oldId === newId) return nothing;
    if (!client.supportsSieve()) return nothing;

    // The account that runs the rules. A rule can only tag mail arriving in
    // its own account, so this is the one to rewrite even in a session where
    // the Sieve and mail primaries are different accounts - which RFC 8620
    // permits, and which the caller's message migration, bound to the mail
    // primary, would not have covered anyway.
    const accountId = client.getSieveAccountId();
    // The same read, render and write a normal save and a rule made from a
    // message use, so the vacation include, forwarding, audience and the
    // plugin pipeline survive the rename.
    const filters = await readAccountFilters(client, accountId);
    if (!filters.script || filters.activeScriptId !== filters.script.id) {
      // Nothing is filtering mail right now. Writing would activate the
      // script, and a tag rename must not switch someone's filters back on.
      return nothing;
    }
    if (filters.parsed.isOpaque) {
      return { changed: 0, unhandled: countKeywordUses(filters.content, oldId) };
    }

    const { rules, changed } = renameKeywordInRules(filters.parsed.rules, oldId, newId);
    if (changed === 0) return { changed: 0, unhandled: countKeywordUses(filters.content, oldId) };

    // A plugin can veto filter saves; the caller warns when this throws.
    await assertFiltersSaveAllowed(rules);
    const written = await writeFiltersScript(client, accountId, renderFiltersScript(rules, filters), filters.script.id);
    // Count what still names the old tag in the script actually written,
    // after the plugin transform: a rule kept verbatim, a test comparing
    // against the keyword, or a section a plugin just grafted back on.
    const unhandled = countKeywordUses(written.content, oldId);
    debug.log('filters', 'Renamed tag in', changed, 'filter action(s)');

    const state = get();
    if (state.selectedAccountId === accountId && !state.isOpaque) {
      set({ rules, rawScript: written.content, activeScriptId: written.scriptId });
    }
    return { changed, unhandled };
  },

  validateScript: async (client, content) => {
    return client.validateSieveScript(content, get().selectedAccountId || undefined);
  },

  addRule: (rule) => {
    // Insert new bulwark rules before external/opaque rules so Bulwark's
    // managed section stays contiguous.
    set((state) => {
      const bulwark = state.rules.filter(r => !r.origin || r.origin === 'bulwark');
      const external = state.rules.filter(r => r.origin === 'external' || r.origin === 'opaque');
      return { rules: [...bulwark, rule, ...external] };
    });
    emitRuleChange(rule.id, 'added');
  },

  updateRule: (ruleId, updates) => {
    if (!isEditableRule(get().rules, ruleId)) return;
    set((state) => ({
      rules: state.rules.map(r => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, ...updates };
      }),
    }));
    emitRuleChange(ruleId, 'updated');
  },

  deleteRule: (ruleId) => {
    if (!isEditableRule(get().rules, ruleId)) return;
    set((state) => ({
      rules: state.rules.filter(r => {
        if (r.id !== ruleId) return true;
        return r.origin === 'external' || r.origin === 'opaque';
      }),
    }));
    emitRuleChange(ruleId, 'deleted');
  },

  reorderRules: (ruleIds) => {
    const before = get().rules;
    // Only reorder bulwark rules; external rules always stay at the end in
    // their original order.
    set((state) => {
      const bulwarkMap = new Map(
        state.rules.filter(r => !r.origin || r.origin === 'bulwark').map(r => [r.id, r]),
      );
      const external = state.rules.filter(r => r.origin === 'external' || r.origin === 'opaque');
      const reordered = ruleIds.map(id => bulwarkMap.get(id)).filter(Boolean) as FilterRule[];
      return { rules: [...reordered, ...external] };
    });
    // A reorder moves several rules at once, so the first rule that changed
    // place stands for it.
    const moved = get().rules.find((r, i) => r.id !== before[i]?.id);
    if (moved) emitRuleChange(moved.id, 'reordered');
  },

  toggleRule: (ruleId) => {
    if (!isEditableRule(get().rules, ruleId)) return;
    set((state) => ({
      rules: state.rules.map(r => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, enabled: !r.enabled };
      }),
    }));
    emitRuleChange(ruleId, 'toggled');
  },

  setRawScript: (content) => set({ rawScript: content }),

  resetToVisualBuilder: () => set({ isOpaque: false, rawScript: '', rules: [], externalRequires: [] }),

  clearState: () => {
    fetchGeneration++;
    set({
      rules: [],
      isLoading: false,
      isSaving: false,
      error: null,
      isSupported: false,
      sieveCapabilities: null,
      activeScriptId: null,
      isOpaque: false,
      rawScript: '',
      vacationSettings: null,
      externalRequires: [],
      includeVacation: false,
      vacationForward: null,
      vacationAudience: null,
      serverRules: '',
      availableAccounts: [],
      selectedAccountId: null,
    });
  },
}));

async function loadManagedScript(client: IJMAPClient, accountId: string) {
  const scripts = await client.getSieveScripts(accountId);
  const vacationScript = scripts.find(s => s.name === VACATION_SCRIPT_NAME);
  const filters = scripts.filter(s => s.name !== VACATION_SCRIPT_NAME);
  const target = filters.find(s => s.isActive) || filters.find(s => s.name === FILTERS_SCRIPT_NAME) || filters[0];
  if (!target) return { vacationScript, target: undefined, parsed: undefined };
  const parsed = parseScript(await client.getSieveScriptContent(target.blobId, accountId));
  return { vacationScript, target, parsed: parsed.isOpaque ? undefined : parsed };
}

/** What the vacation card needs from the account's filters script. */
export interface VacationFilters {
  /**
   * The filters script runs the server's vacation script. VacationResponse
   * .isEnabled reads false in that case, because the vacation script itself
   * is not the active one.
   */
  includesVacation: boolean;
  /** The forwarding as stored, on or off; null when none is set up. */
  forward: VacationForward | null;
  /**
   * Forwarding can be set up: it runs from the filters script next to the
   * included vacation script, so it needs `include`, a script Bulwark can
   * read, a server that allows a redirect and what the block uses besides
   * (its period, its spam check, the copy). Forwarding that is on is offered
   * all the same, so that it can be switched off.
   */
  forwardAvailable: boolean;
  /** Who gets the auto-reply as stored; null when everyone does. */
  audience: VacationAudience | null;
  /**
   * The auto-reply can be narrowed to some senders: it then runs from the
   * filters script, so this needs `include`, `envelope` and a script Bulwark
   * can read.
   */
  audienceAvailable: boolean;
  /**
   * Forwarding that is on, or an auto-reply for some senders only, is stored
   * but does not run: both run only from the active filters script, and
   * Stalwart's own vacation script took over (a save cut short, another
   * client), or no script runs at all. Saving the card sets it right.
   */
  notRunning: boolean;
  /**
   * The most forwards the filter rules let one message collect (see
   * worstCaseForwards). Forwarding that keeps a copy runs ahead of them, so
   * it shares the server's redirect limit with these.
   */
  otherForwards: number;
}

/** See VacationFilters.notRunning. */
function storedButIdle(
  filtersActive: boolean,
  vacationActive: boolean,
  forward: VacationForward | null,
  audience: VacationAudience | null,
): boolean {
  if (filtersActive) return false;
  return !!forward?.enabled || (!!audience && vacationActive);
}

/** The server runs the forwarding block: a redirect, its period, its spam check and the copy. */
function canForward(capabilities: SieveCapabilities | null | undefined): boolean {
  const extensions = capabilities?.sieveExtensions;
  return capabilities?.maxNumberRedirects !== 0 &&
    supportsPeriods(extensions) &&
    supportsSpamGuard(extensions) &&
    !!extensions?.includes('copy');
}

export async function readVacationFilters(client: IJMAPClient, accountId?: string): Promise<VacationFilters> {
  const sieveAccountId = accountId || client.getSieveAccountId();
  const capabilities = client.getSieveCapabilities(sieveAccountId);
  const { vacationScript, target, parsed } = await loadManagedScript(client, sieveAccountId);
  const filtersUsable = supportsInclude(capabilities) && !(target && !parsed);
  const forward = parsed?.vacationForward ?? null;
  const audience = parsed?.vacationAudience ?? null;
  return {
    includesVacation: !!(vacationScript && target?.isActive && parsed?.includeVacation),
    forward,
    forwardAvailable: filtersUsable && (canForward(capabilities) || !!forward?.enabled),
    audience,
    // Told apart by the envelope sender, which the auto-reply goes to.
    audienceAvailable: filtersUsable && !!capabilities?.sieveExtensions?.includes('envelope'),
    notRunning: storedButIdle(!!target?.isActive, !!vacationScript?.isActive, forward, audience),
    otherForwards: worstCaseForwards(parsed?.rules ?? []),
  };
}

function same<T>(a: T | null, b: T | null, normalize: (value: T) => T): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// The same moment, however it is written: the server hands the vacation's
// dates back in its own form.
function sameMoment(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a === b || Date.parse(a) === Date.parse(b);
}

function sameForward(a: VacationForward | null, b: VacationForward | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.to === b.to && a.keepCopy === b.keepCopy &&
    sameMoment(a.activeFrom, b.activeFrom) && sameMoment(a.activeUntil, b.activeUntil);
}

/**
 * Keep the filters, the auto-reply and its forwarding running after
 * VacationResponse/set.
 *
 * Stalwart allows one active Sieve script and turns the auto-reply on by
 * activating its own "vacation" script, which switches every filter off.
 * When that happened, re-activate the filters script with an `include` of
 * the vacation script. When the auto-reply is turned off, drop the include.
 *
 * `forward` replaces the stored forwarding (null removes it, undefined keeps
 * it). Forwarding runs with or without the auto-reply, but only from an
 * active filters script, so for it the script is activated even without
 * rules, and created when there is none. `audience` likewise replaces who
 * gets the auto-reply (null: everyone). `period` is the vacation's, which
 * whatever forwarding there is keeps to.
 */
export async function syncVacationWithFilters(
  client: IJMAPClient,
  enabled: boolean,
  accountId?: string,
  forward?: VacationForward | null,
  audience?: VacationAudience | null,
  period?: { from: string | null; until: string | null },
): Promise<void> {
  const sieveAccountId = accountId || client.getSieveAccountId();
  const capabilities = client.getSieveCapabilities(sieveAccountId);
  const canInclude = supportsInclude(capabilities);
  if (enabled && !canInclude && forward === undefined && audience === undefined) return;

  const { vacationScript, target, parsed } = await loadManagedScript(client, sieveAccountId);
  const opaque = !!target && !parsed;
  const storedForward = parsed?.vacationForward ?? null;
  const storedAudience = parsed?.vacationAudience ?? null;
  const requestedForward = forward === undefined ? storedForward : forward;
  const nextForward = requestedForward && period ? withVacationPeriod(requestedForward, period) : requestedForward;
  const nextAudience = audience === undefined ? storedAudience : audience;
  const changed =
    !sameForward(storedForward, nextForward) ||
    !same(storedAudience, nextAudience, normalizeVacationAudience);

  if (changed) {
    // The card only offers these where they can be stored and run.
    if (opaque) throw new OpaqueFiltersError();
    if (!canInclude) throw new Error('Forwarding and reply recipients need the Sieve "include" extension');
    // The generator leaves out what it could not read back, and the save
    // would look done while nothing forwards, or everyone gets the reply.
    if (nextForward && !isValidVacationForward(nextForward)) throw new Error('Unusable vacation forwarding');
    if (nextAudience && !isValidVacationAudience(nextAudience)) throw new Error('Unusable vacation reply recipients');
  }
  if ((enabled && !canInclude) || opaque) return;

  const rules = parsed?.rules ?? [];
  const forwarding = !!nextForward?.enabled;
  if (enabled) {
    // Act when the vacation script took over from filters that must keep
    // running, or when something changed. An auto-reply for some senders
    // only must run from the filters script: on its own it answers everyone.
    const tookOver = !!vacationScript?.isActive && !target?.isActive;
    // The host's server rules run only from the filters script too.
    const needsFilters = rules.length > 0 || forwarding || !!nextAudience || !!parsed?.serverRules;
    if (!changed && !(tookOver && needsFilters)) return;
  } else {
    // Forwarding and the host's server rules also run without the
    // auto-reply, from an active filters script; turning the auto-reply off
    // can leave no script active.
    const filtersIdle = (forwarding || !!parsed?.serverRules) && !target?.isActive;
    if (!changed && !parsed?.includeVacation && !filtersIdle) return;
  }

  const content = await applyScriptTransforms(
    generateScript(rules, parsed?.vacation, {
      externalRequires: parsed?.externalRequires,
      includeVacation: enabled,
      vacationForward: nextForward,
      vacationAudience: nextAudience,
      extensions: capabilities?.sieveExtensions,
      serverRules: parsed?.serverRules,
    }),
    sieveAccountId,
  );
  const activate = enabled || forwarding || !!parsed?.serverRules || !!target?.isActive;
  if (target) {
    await client.updateSieveScript(target.id, content, activate, sieveAccountId);
  } else {
    await client.createSieveScript(FILTERS_SCRIPT_NAME, content, activate, sieveAccountId);
  }
  debug.log('filters', enabled ? 'Filters now include the vacation script' : 'Removed the vacation include');

  const store = useFilterStore.getState();
  if (store.selectedAccountId === sieveAccountId) {
    await store.fetchFilters(client, sieveAccountId);
  }
}
