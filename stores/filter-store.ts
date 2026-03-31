import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FilterRule, SieveCapabilities, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { parseScript } from '@/lib/sieve/parser';
import { generateScript } from '@/lib/sieve/generator';
import { debug } from '@/lib/debug';

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

  setSupported: (supported: boolean) => void;
  fetchFilters: (client: IJMAPClient) => Promise<void>;
  saveFilters: (client: IJMAPClient) => Promise<void>;
  validateScript: (client: IJMAPClient, content: string) => Promise<{ isValid: boolean; errors?: string[] }>;
  addRule: (rule: FilterRule) => void;
  updateRule: (ruleId: string, updates: Partial<FilterRule>) => void;
  deleteRule: (ruleId: string) => void;
  reorderRules: (ruleIds: string[]) => void;
  toggleRule: (ruleId: string) => void;
  setRawScript: (content: string) => void;
  resetToVisualBuilder: () => void;
  syncVacationToScript: (client: IJMAPClient, vacation: VacationSieveConfig) => Promise<void>;
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

  setSupported: (supported) => set({ isSupported: supported }),

  fetchFilters: async (client) => {
    set({ isLoading: true, error: null });
    try {
      const capabilities = client.getSieveCapabilities();
      set({ sieveCapabilities: capabilities });

      const allScripts = await client.getSieveScripts();
      debug.log('filters', 'Sieve scripts fetched:', allScripts.length);

      // Skip the server-managed 'vacation' script (RFC 9661 §4) — it can only
      // be modified via VacationResponse/set, not SieveScript/set.
      const scripts = allScripts.filter(s => s.name !== 'vacation');

      const activeScript = scripts.find(s => s.isActive) || scripts[0];
      if (!activeScript) {
        set({ isLoading: false, rules: [], activeScriptId: null, rawScript: '', isOpaque: false });
        return;
      }

      set({ activeScriptId: activeScript.id });

      const content = await client.getSieveScriptContent(activeScript.blobId);
      set({ rawScript: content });

      const result = parseScript(content);

      if (result.isOpaque) {
        debug.log('filters', 'Sieve script is opaque (hand-edited)');
        set({ isLoading: false, isOpaque: true, rules: [], vacationSettings: result.vacation || null });
      } else {
        debug.log('filters', 'Parsed', result.rules.length, 'filter rules');
        set({ isLoading: false, isOpaque: false, rules: result.rules, vacationSettings: result.vacation || null });
      }
    } catch (error) {
      debug.error('Failed to fetch filters:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch filters',
      });
    }
  },

  saveFilters: async (client) => {
    set({ isSaving: true, error: null });
    try {
      const { isOpaque, rawScript, rules, activeScriptId, vacationSettings } = get();

      let content: string;
      if (isOpaque) {
        content = rawScript;
      } else {
        content = generateScript(rules, vacationSettings || undefined);
      }

      if (activeScriptId) {
        await client.updateSieveScript(activeScriptId, content, true);
      } else {
        const script = await client.createSieveScript('filters', content, true);
        set({ activeScriptId: script.id });
      }

      set({ isSaving: false, rawScript: content });
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

  validateScript: async (client, content) => {
    return client.validateSieveScript(content);
  },

  addRule: (rule) => {
    set((state) => ({ rules: [...state.rules, rule] }));
  },

  updateRule: (ruleId, updates) => {
    set((state) => ({
      rules: state.rules.map(r => r.id === ruleId ? { ...r, ...updates } : r),
    }));
  },

  deleteRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.filter(r => r.id !== ruleId),
    }));
  },

  reorderRules: (ruleIds) => {
    set((state) => {
      const ruleMap = new Map(state.rules.map(r => [r.id, r]));
      const reordered = ruleIds.map(id => ruleMap.get(id)).filter(Boolean) as FilterRule[];
      return { rules: reordered };
    });
  },

  toggleRule: (ruleId) => {
    set((state) => ({
      rules: state.rules.map(r =>
        r.id === ruleId ? { ...r, enabled: !r.enabled } : r
      ),
    }));
  },

  setRawScript: (content) => set({ rawScript: content }),

  resetToVisualBuilder: () => set({ isOpaque: false, rawScript: '', rules: [] }),

  syncVacationToScript: async (client, vacation) => {
    try {
      // Preserve current rules before re-fetching, since the server
      // may have overwritten our script with a vacation-only one.
      const { rules: previousRules } = get();

      // Always re-fetch scripts from the server to get the current state
      // after Stalwart may have rewritten the active script.
      const allScripts = await client.getSieveScripts();
      // Skip the server-managed 'vacation' script (RFC 9661 §4)
      const scripts = allScripts.filter(s => s.name !== 'vacation');
      const activeScript = scripts.find(s => s.isActive) || scripts[0];

      let rules = previousRules;

      // If there's an active script, try to parse our metadata from it.
      // If the server overwrote it (no metadata), fall back to stored rules.
      if (activeScript) {
        const content = await client.getSieveScriptContent(activeScript.blobId);
        const parsed = parseScript(content);
        if (!parsed.isOpaque) {
          rules = parsed.rules;
        }
      }

      // Generate a combined script with our metadata, rules, and vacation
      const content = generateScript(rules, vacation.isEnabled ? vacation : undefined);

      if (activeScript) {
        // Preserve the script's current activation state — don't pass activate: true
        // unconditionally, as that would deactivate the server-managed 'vacation'
        // script and cause VacationResponse/get to return isEnabled: false.
        await client.updateSieveScript(activeScript.id, content, activeScript.isActive);
        set({
          activeScriptId: activeScript.id,
          rawScript: content,
          rules,
          vacationSettings: vacation,
          isOpaque: false,
        });
      } else {
        // Don't activate; there may be a server-managed 'vacation' script active.
        // The filters script will be activated when the user saves filters normally.
        const script = await client.createSieveScript('filters', content, false);
        set({
          activeScriptId: script.id,
          rawScript: content,
          rules,
          vacationSettings: vacation,
          isOpaque: false,
        });
      }

      debug.log('filters', 'Vacation synced to sieve script');
    } catch (error) {
      debug.error('Failed to sync vacation to sieve script:', error);
    }
  },

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
  }),
}));
