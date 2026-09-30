import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { parseScript } from '@/lib/sieve/parser';
import { generateScript, VACATION_SCRIPT_NAME } from '@/lib/sieve/generator';
import { filterHooks } from '@/lib/plugin-hooks';
import { debug } from '@/lib/debug';

interface SieveAccount {
  id: string;
  name: string;
  isPrimary: boolean;
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
  availableAccounts: SieveAccount[];
  selectedAccountId: string | null;

  setSupported: (supported: boolean) => void;
  fetchFilters: (client: IJMAPClient, accountId?: string) => Promise<void>;
  selectAccount: (client: IJMAPClient, accountId: string) => Promise<void>;
  saveFilters: (client: IJMAPClient) => Promise<void>;
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

      const activeScript = scripts.find(s => s.isActive) || scripts[0];
      if (!activeScript) {
        set({
          isLoading: false,
          rules: [],
          activeScriptId: null,
          rawScript: '',
          isOpaque: false,
          includeVacation: vacationActive,
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
        set({
          isLoading: false,
          isOpaque: true,
          rules: [],
          vacationSettings: result.vacation || null,
          externalRequires: result.externalRequires,
          includeVacation: false,
        });
      } else {
        debug.log('filters', 'Parsed', result.rules.length, 'filter rules');
        set({
          isLoading: false,
          isOpaque: false,
          rules: result.rules,
          vacationSettings: result.vacation || null,
          externalRequires: result.externalRequires,
          includeVacation: !!result.includeVacation || vacationActive,
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
    });
    await get().fetchFilters(client, accountId);
  },

  saveFilters: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const {
        isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, includeVacation,
        selectedAccountId, sieveCapabilities,
      } = get();

      let content: string;
      if (isOpaque) {
        content = rawScript;
      } else {
        content = generateScript(rules, vacationSettings || undefined, {
          externalRequires,
          includeVacation,
          extensions: sieveCapabilities?.sieveExtensions,
        });
      }
      content = await applyScriptTransforms(content, selectedAccountId || null);

      if (activeScriptId) {
        await client.updateSieveScript(activeScriptId, content, true, selectedAccountId || undefined);
      } else {
        const script = await client.createSieveScript('filters', content, true, selectedAccountId || undefined);
        set({ activeScriptId: script.id });
      }

      set({ isSaving: false, rawScript: content });
      debug.log('filters', 'Filters saved successfully');
      void filterHooks.onFiltersSave.emit({ accountId: selectedAccountId || null });
      void filterHooks.onSieveScriptChange.emit({ accountId: selectedAccountId || null, script: content });
    } catch (error) {
      debug.error('Failed to save filters:', error);
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save filters',
      });
      throw error;
    }
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
  },

  updateRule: (ruleId, updates) => {
    set((state) => ({
      rules: state.rules.map(r => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, ...updates };
      }),
    }));
  },

  deleteRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.filter(r => {
        if (r.id !== ruleId) return true;
        return r.origin === 'external' || r.origin === 'opaque';
      }),
    }));
  },

  reorderRules: (ruleIds) => {
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
  },

  toggleRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.map(r => {
        if (r.id !== ruleId) return r;
        if (r.origin === 'external' || r.origin === 'opaque') return r; // read-only
        return { ...r, enabled: !r.enabled };
      }),
    }));
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
      availableAccounts: [],
      selectedAccountId: null,
    });
  },
}));

function supportsInclude(capabilities: SieveCapabilities | null): boolean {
  return capabilities?.sieveExtensions?.includes('include') ?? false;
}

// Let plugins graft their managed sections (e.g. an inbox-category
// classifier) into the script before it becomes the active one. A handler
// returning a non-string is ignored to keep the upload valid.
async function applyScriptTransforms(content: string, accountId: string | null): Promise<string> {
  const transformed = await filterHooks.onSieveScriptGenerate.transform(content, { accountId });
  return typeof transformed === 'string' && transformed.trim().length > 0 ? transformed : content;
}

async function loadManagedScript(client: IJMAPClient, accountId: string) {
  const scripts = await client.getSieveScripts(accountId);
  const vacationScript = scripts.find(s => s.name === VACATION_SCRIPT_NAME);
  const filters = scripts.filter(s => s.name !== VACATION_SCRIPT_NAME);
  const target = filters.find(s => s.isActive) || filters[0];
  if (!target) return { vacationScript, target: undefined, parsed: undefined };
  const parsed = parseScript(await client.getSieveScriptContent(target.blobId, accountId));
  return { vacationScript, target, parsed: parsed.isOpaque ? undefined : parsed };
}

/**
 * Whether the account's filters script runs the server's vacation script.
 * VacationResponse.isEnabled reads false in that case, because the vacation
 * script itself is not the active one.
 */
export async function isVacationIncludedInFilters(
  client: IJMAPClient,
  accountId?: string,
): Promise<boolean> {
  const sieveAccountId = accountId || client.getSieveAccountId();
  const { vacationScript, target, parsed } = await loadManagedScript(client, sieveAccountId);
  return !!(vacationScript && target?.isActive && parsed?.includeVacation);
}

/**
 * Keep the filters and the auto-reply both running after VacationResponse/set.
 *
 * Stalwart allows one active Sieve script and turns the auto-reply on by
 * activating its own "vacation" script, which switches every filter off.
 * When that happened, re-activate the filters script with an `include` of
 * the vacation script. When the auto-reply is turned off, drop the include.
 */
export async function syncVacationWithFilters(
  client: IJMAPClient,
  enabled: boolean,
  accountId?: string,
): Promise<void> {
  const sieveAccountId = accountId || client.getSieveAccountId();
  const capabilities = client.getSieveCapabilities(sieveAccountId);
  if (enabled && !supportsInclude(capabilities)) return;

  const { vacationScript, target, parsed } = await loadManagedScript(client, sieveAccountId);
  if (!target || !parsed) return;

  if (enabled) {
    // Only act when the vacation script took over from existing filters.
    if (!vacationScript?.isActive || target.isActive || parsed.rules.length === 0) return;
  } else if (!parsed.includeVacation) {
    return;
  }

  const content = await applyScriptTransforms(
    generateScript(parsed.rules, parsed.vacation, {
      externalRequires: parsed.externalRequires,
      includeVacation: enabled,
      extensions: capabilities?.sieveExtensions,
    }),
    sieveAccountId,
  );
  await client.updateSieveScript(target.id, content, enabled || target.isActive, sieveAccountId);
  debug.log('filters', enabled ? 'Filters now include the vacation script' : 'Removed the vacation include');

  const store = useFilterStore.getState();
  if (store.selectedAccountId === sieveAccountId) {
    await store.fetchFilters(client, sieveAccountId);
  }
}
