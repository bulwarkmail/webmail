import { create } from 'zustand';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { QuickRuleTarget } from '@/lib/filters/quick-rule-target';
import type { QuickRulePreset, QuickRuleSubject, RuleMailbox, RuleSuggestion } from '@/lib/filters/quick-rules';

/**
 * State for rules made from a message. The menus that start them close right
 * away, so the rule editor and the folder-name prompt they open are drawn by
 * QuickRuleHost, which stays mounted.
 */

export type FiltersStatus = 'loading' | 'ready' | 'opaque' | 'error';

export interface QuickRuleEditor {
  /** 'prefill': "Create rule…" on a message. 'edit': an existing rule, from a toast. */
  mode: 'prefill' | 'edit';
  target: QuickRuleTarget;
  rule: FilterRule;
  suggestions: RuleSuggestion[];
  /** Folder (store id) "Also apply to existing messages" runs over. */
  sourceMailboxId: string | null;
}

export interface NewFolderRequest {
  target: QuickRuleTarget;
  subject: QuickRuleSubject;
  sourceMailboxId: string | null;
  /** The preset to save once the folder exists. */
  preset: (mailbox: RuleMailbox) => QuickRulePreset;
}

interface QuickRuleStore {
  editor: QuickRuleEditor | null;
  newFolder: NewFolderRequest | null;
  /** Whether each account's script can be written, by QuickRuleTarget.key. */
  statuses: Record<string, { status: FiltersStatus; at: number }>;
  openEditor: (editor: QuickRuleEditor) => void;
  closeEditor: () => void;
  requestNewFolder: (request: NewFolderRequest) => void;
  closeNewFolder: () => void;
  setStatus: (key: string, status: FiltersStatus) => void;
}

export const useQuickRuleStore = create<QuickRuleStore>()((set) => ({
  editor: null,
  newFolder: null,
  statuses: {},
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  requestNewFolder: (newFolder) => set({ newFolder }),
  closeNewFolder: () => set({ newFolder: null }),
  setStatus: (key, status) =>
    set((state) => ({ statuses: { ...state.statuses, [key]: { status, at: Date.now() } } })),
}));
