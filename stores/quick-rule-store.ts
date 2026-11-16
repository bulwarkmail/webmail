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

/** "Move N messages to Trash?" before a rule that discards runs on a folder. */
export interface TrashQuestion {
  count: number;
  answer: (confirmed: boolean) => void;
}

interface QuickRuleStore {
  editor: QuickRuleEditor | null;
  newFolder: NewFolderRequest | null;
  trashQuestion: TrashQuestion | null;
  /** Whether each account's script can be written, by QuickRuleTarget.key. */
  statuses: Record<string, { status: FiltersStatus; at: number }>;
  openEditor: (editor: QuickRuleEditor) => void;
  closeEditor: () => void;
  requestNewFolder: (request: NewFolderRequest) => void;
  closeNewFolder: () => void;
  /** Resolves true when the user confirms; a second question cancels the first. */
  askTrash: (count: number) => Promise<boolean>;
  answerTrash: (confirmed: boolean) => void;
  setStatus: (key: string, status: FiltersStatus) => void;
}

export const useQuickRuleStore = create<QuickRuleStore>()((set, get) => ({
  editor: null,
  newFolder: null,
  trashQuestion: null,
  statuses: {},
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  requestNewFolder: (newFolder) => set({ newFolder }),
  closeNewFolder: () => set({ newFolder: null }),
  askTrash: (count) => {
    get().answerTrash(false);
    return new Promise<boolean>((resolve) => set({ trashQuestion: { count, answer: resolve } }));
  },
  answerTrash: (confirmed) => {
    const question = get().trashQuestion;
    if (!question) return;
    set({ trashQuestion: null });
    question.answer(confirmed);
  },
  setStatus: (key, status) =>
    set((state) => ({ statuses: { ...state.statuses, [key]: { status, at: Date.now() } } })),
}));
