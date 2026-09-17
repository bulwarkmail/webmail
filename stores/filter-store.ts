import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { parseScript } from '@/lib/sieve/parser';
import { generateScript } from '@/lib/sieve/generator';
import { countKeywordUses, renameKeywordInRules } from '@/lib/sieve/keyword-rename';
import { filterHooks } from '@/lib/plugin-hooks';
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
  availableAccounts: [],
  selectedAccountId: null,

  setSupported: (supported) => set({ isSupported: supported }),

  fetchFilters: async (client, accountId) => {
    set({ isLoading: true, error: null });
    try {
      const accounts = client.getSieveAccounts();
      const resolvedId =
        accountId || get().selectedAccountId || client.getSieveAccountId();
      set({ availableAccounts: accounts, selectedAccountId: resolvedId });

      const capabilities = client.getSieveCapabilities(resolvedId);
      set({ sieveCapabilities: capabilities });

      const allScripts = await client.getSieveScripts(resolvedId);
      debug.log('filters', 'Sieve scripts fetched:', allScripts.length);

      // Skip the server-managed 'vacation' script (RFC 9661 §4) - it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter(s => s.name !== 'vacation');

      const activeScript = scripts.find(s => s.isActive) || scripts[0];
      if (!activeScript) {
        set({ isLoading: false, rules: [], activeScriptId: null, rawScript: '', isOpaque: false });
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await client.getSieveScriptContent(activeScript.blobId, resolvedId);
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
        });
      } else {
        debug.log('filters', 'Parsed', result.rules.length, 'filter rules');
        set({
          isLoading: false,
          isOpaque: false,
          rules: result.rules,
          vacationSettings: result.vacation || null,
          externalRequires: result.externalRequires,
        });
      }
    } catch (error) {
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
    });
    await get().fetchFilters(client, accountId);
  },

  saveFilters: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const { isOpaque, rawScript, rules, activeScriptId, vacationSettings, externalRequires, selectedAccountId } = get();

      let content: string;
      if (isOpaque) {
        content = rawScript;
      } else {
        content = generateScript(rules, vacationSettings || undefined, { externalRequires });
      }

      // Let plugins graft their managed sections (e.g. an inbox-category
      // classifier) into the script before it becomes the active one. A
      // handler returning a non-string is ignored to keep the upload valid.
      const transformed = await filterHooks.onSieveScriptGenerate.transform(content, {
        accountId: selectedAccountId || null,
      });
      if (typeof transformed === 'string' && transformed.trim().length > 0) {
        content = transformed;
      }

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
    const scripts = (await client.getSieveScripts(accountId)).filter(s => s.name !== 'vacation');
    const activeScript = scripts.find(s => s.isActive);
    if (!activeScript) {
      // Nothing is filtering mail right now. Rewriting an inactive script would
      // mean activating it - updateSieveScript activates on write - and a tag
      // rename must not switch someone's filters back on.
      return nothing;
    }

    const content = await client.getSieveScriptContent(activeScript.blobId, accountId);
    const parsed = parseScript(content);
    if (parsed.isOpaque) {
      return { changed: 0, unhandled: countKeywordUses(content, oldId) };
    }

    const { rules, changed } = renameKeywordInRules(parsed.rules, oldId, newId);
    if (changed === 0) return { changed: 0, unhandled: countKeywordUses(content, oldId) };

    let script = generateScript(rules, parsed.vacation || undefined, {
      externalRequires: parsed.externalRequires,
    });
    // Same plugin pipeline a normal save runs through: a plugin's managed
    // section is grafted on at generate time, so skipping the transform here
    // would drop it from the script this write makes active.
    const transformed = await filterHooks.onSieveScriptGenerate.transform(script, { accountId });
    if (typeof transformed === 'string' && transformed.trim().length > 0) {
      script = transformed;
    }

    // Count what still names the old tag in the script actually being written,
    // after the plugin transform: a rule kept verbatim, a test comparing
    // against the keyword, or a section a plugin just grafted back on.
    const unhandled = countKeywordUses(script, oldId);

    await client.updateSieveScript(activeScript.id, script, true, accountId);
    debug.log('filters', 'Renamed tag in', changed, 'filter action(s)');

    const state = get();
    if (state.selectedAccountId === accountId && !state.isOpaque) {
      set({
        rules,
        rawScript: script,
        activeScriptId: activeScript.id,
        vacationSettings: parsed.vacation || null,
        externalRequires: parsed.externalRequires,
      });
    }
    void filterHooks.onSieveScriptChange.emit({ accountId, script });
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

  clearState: () => set({
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
    availableAccounts: [],
    selectedAccountId: null,
  }),
}));
