import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateUUID } from '@/lib/utils';
import { buildSettingsPath } from '@/lib/deep-links';
import { keywordPointer, pointerToken } from '@/lib/jmap/patch-pointer';
import { toast } from '@/stores/toast-store';
import type { ToastAction } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore, type BatchActionTarget } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useQuickRuleStore, type NewFolderRequest, type QuickRuleEditor } from '@/stores/quick-rule-store';
import {
  FiltersChangedError,
  OpaqueFiltersError,
  readAccountFilters,
  restoreAccountFilters,
  updateAccountFilters,
  type FiltersChange,
} from './account-filters';
import {
  applyQuickRule,
  buildPresetRule,
  insertRuleAtTop,
  replaceOrInsertRule,
  type QuickRuleOutcome,
  type QuickRulePreset,
  type QuickRuleSubject,
  type Translate,
} from './quick-rules';
import {
  planRetroactive,
  retroactiveSupport,
  retroProperties,
  retroQueryFilter,
  toRetroMessage,
  type RetroPlan,
} from './retroactive';
import type { QuickRuleTarget } from './quick-rule-target';

/** Translators for the namespaces the flow speaks in. */
export interface QuickRuleText {
  /** `notifications` */
  notifications: Translate;
  /** `settings.filters` */
  filters: Translate;
  /** `context_menu` */
  menu: Translate;
}

const EMPTY_PLAN: RetroPlan = { ids: [], steps: [] };
/** How long a fetched "can this script be written" answer is trusted. */
const STATUS_TTL_MS = 60_000;
const SAVED_TOAST_MS = 12_000;

/** Whether the filter store holds this account's script right now. */
export function filterStoreHolds(target: QuickRuleTarget): boolean {
  const filters = useFilterStore.getState();
  return useAuthStore.getState().client === target.client
    && filters.selectedAccountId === target.sieveAccountId
    && filters.isSupported
    && !filters.isLoading
    && !filters.error;
}

/**
 * Find out whether the account's script can take a rule (it is not a
 * hand-edited one). The filter store answers for the account it holds;
 * other accounts are read once and remembered for a minute. The save itself
 * reads the script again, so a stale answer never leads to a bad write.
 */
export function ensureFiltersStatus(target: QuickRuleTarget): void {
  const quick = useQuickRuleStore.getState();
  if (filterStoreHolds(target)) return;
  const cached = quick.statuses[target.key];
  if (cached && (cached.status === 'loading' || Date.now() - cached.at < STATUS_TTL_MS)) return;
  quick.setStatus(target.key, 'loading');
  readAccountFilters(target.client, target.sieveAccountId)
    .then(f => useQuickRuleStore.getState().setStatus(target.key, f.parsed.isOpaque ? 'opaque' : 'ready'))
    .catch(() => useQuickRuleStore.getState().setStatus(target.key, 'error'));
}

/** Let the Settings panel show the new state when it holds this account. */
function refreshFilterStore(target: QuickRuleTarget): void {
  const filters = useFilterStore.getState();
  if (useAuthStore.getState().client === target.client && filters.selectedAccountId === target.sieveAccountId) {
    void filters.fetchFilters(target.client, target.sieveAccountId);
  }
}

function reportWriteError(error: unknown, target: QuickRuleTarget, text: QuickRuleText): void {
  if (error instanceof OpaqueFiltersError) {
    useQuickRuleStore.getState().setStatus(target.key, 'opaque');
    toast.error(text.menu('rules.opaque_hint'));
    return;
  }
  toast.error(text.notifications('filters_save_failed'), error instanceof Error ? error.message : undefined);
}

/** What the rule would do to the mail already in `sourceMailboxId`. */
export async function planOnServer(
  target: QuickRuleTarget,
  rule: FilterRule,
  sourceMailboxId: string | null,
): Promise<RetroPlan> {
  if (!sourceMailboxId || !retroactiveSupport(rule).ok) return EMPTY_PLAN;
  const mailbox = target.mailboxes.find(m => m.id === sourceMailboxId);
  const records = await target.client.queryEmailFields(
    retroQueryFilter(rule, mailbox?.originalId || sourceMailboxId),
    retroProperties(rule),
    target.accountId,
  );
  return planRetroactive(rule, records.map(toRetroMessage));
}

async function planSafely(target: QuickRuleTarget, rule: FilterRule, sourceMailboxId: string | null): Promise<RetroPlan> {
  try {
    return await planOnServer(target, rule, sourceMailboxId);
  } catch {
    return EMPTY_PLAN;
  }
}

/**
 * Carry out a plan through the store's batch actions, so the list and its
 * counters update as they do for a manual move. Keyword and copy steps have
 * no batch action; they go to the server directly and patch loaded rows.
 */
export async function executePlan(target: QuickRuleTarget, plan: RetroPlan): Promise<void> {
  const store = () => useEmailStore.getState();
  const viewClient = useAuthStore.getState().client ?? target.client;
  const batch = (ids: string[]): BatchActionTarget => ({ emailIds: ids, client: target.client, accountId: target.accountId });
  // The batch actions report a failure in `error` rather than throwing.
  const check = () => {
    const error = store().error;
    if (error) throw new Error(error);
  };
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'mark_read':
        await store().batchMarkAsRead(viewClient, true, batch(step.ids));
        check();
        break;
      case 'keyword': {
        await target.client.batchUpdateKeywords(step.ids, { [keywordPointer(step.keyword)]: true }, target.accountId);
        const listed = new Map(store().emails.map(e => [e.id, e]));
        for (const id of step.ids) {
          const email = listed.get(id);
          if (email) store().setEmailKeywordsLocal(id, { ...email.keywords, [step.keyword]: true });
        }
        break;
      }
      case 'copy':
        await target.client.batchUpdateKeywords(
          step.ids, { [`mailboxIds/${pointerToken(step.mailboxId)}`]: true }, target.accountId,
        );
        break;
      case 'move':
        await store().batchMoveToMailbox(viewClient, step.mailboxId, batch(step.ids));
        check();
        break;
    }
  }
}

/** Run `rule` over the mail already in the folder; returns how many messages changed. */
export async function applyRuleToExisting(
  target: QuickRuleTarget,
  rule: FilterRule,
  sourceMailboxId: string | null,
): Promise<number> {
  const plan = await planOnServer(target, rule, sourceMailboxId);
  await executePlan(target, plan);
  return plan.ids.length;
}

async function applyAndReport(
  target: QuickRuleTarget,
  rule: FilterRule,
  sourceMailboxId: string | null,
  text: QuickRuleText,
): Promise<void> {
  try {
    const count = await applyRuleToExisting(target, rule, sourceMailboxId);
    toast.success(text.notifications('rule_applied', { count }));
  } catch (error) {
    toast.error(text.notifications('rule_apply_failed'), error instanceof Error ? error.message : undefined);
  }
}

/**
 * Open the rule editor on `ruleId` as the server has it now (the toast's copy
 * may be stale); `fallback` when it cannot be read.
 */
export async function openRuleEditor(
  target: QuickRuleTarget,
  ruleId: string,
  fallback: FilterRule,
  sourceMailboxId: string | null,
  text: QuickRuleText,
): Promise<void> {
  let rule = fallback;
  try {
    const filters = await readAccountFilters(target.client, target.sieveAccountId);
    if (filters.parsed.isOpaque) {
      reportWriteError(new OpaqueFiltersError(), target, text);
      return;
    }
    rule = filters.parsed.rules.find(r => r.id === ruleId) ?? fallback;
  } catch {
    // Edit the copy we have; the save reads the script again anyway.
  }
  useQuickRuleStore.getState().openEditor({ mode: 'edit', target, rule, suggestions: [], sourceMailboxId });
}

function editAction(target: QuickRuleTarget, rule: FilterRule, sourceMailboxId: string | null, text: QuickRuleText): ToastAction {
  return {
    label: text.notifications('rule_edit'),
    onClick: () => { void openRuleEditor(target, rule.id, rule, sourceMailboxId, text); },
  };
}

async function undoChange(target: QuickRuleTarget, change: FiltersChange, text: QuickRuleText): Promise<void> {
  try {
    await restoreAccountFilters(target.client, change);
    refreshFilterStore(target);
    toast.success(text.notifications('rule_undone'));
  } catch (error) {
    toast.error(error instanceof FiltersChangedError
      ? text.notifications('rule_undo_conflict')
      : text.notifications('rule_undo_failed'));
  }
}

function undoAction(target: QuickRuleTarget, change: FiltersChange, text: QuickRuleText): ToastAction {
  return { label: text.notifications('rule_undo'), onClick: () => { void undoChange(target, change, text); } };
}

/**
 * Save a one-click rule right away, merged into an existing rule that does
 * the same thing where there is one, and offer to apply it to the mail
 * already in the folder, to edit it, or to undo it.
 */
export async function runPresetRule(params: {
  target: QuickRuleTarget;
  preset: QuickRulePreset;
  subject: QuickRuleSubject;
  sourceMailboxId: string | null;
  text: QuickRuleText;
}): Promise<void> {
  const { target, preset, subject, sourceMailboxId, text } = params;
  const candidate = buildPresetRule(preset, subject, text.filters, generateUUID());
  const result: { outcome?: QuickRuleOutcome } = {};
  let change: FiltersChange | null;
  try {
    change = await updateAccountFilters(target.client, target.sieveAccountId, (rules) => {
      result.outcome = applyQuickRule(rules, candidate);
      return result.outcome.kind === 'covered' ? null : result.outcome.rules;
    });
  } catch (error) {
    reportWriteError(error, target, text);
    return;
  }
  useQuickRuleStore.getState().setStatus(target.key, 'ready');
  const outcome = result.outcome!;

  if (outcome.kind === 'covered' || !change) {
    toast.info(text.notifications('rule_already_covered', { name: outcome.rule.name }), {
      action: editAction(target, outcome.rule, sourceMailboxId, text),
    });
    return;
  }

  refreshFilterStore(target);
  const plan = await planSafely(target, outcome.added, sourceMailboxId);
  const added = outcome.added;
  toast.success(
    outcome.kind === 'merged'
      ? text.notifications('rule_merged', { name: outcome.rule.name })
      : text.notifications('rule_created'),
    {
      message: outcome.kind === 'created' ? outcome.rule.name : undefined,
      duration: SAVED_TOAST_MS,
      action: undoAction(target, change, text),
      secondaryAction: editAction(target, outcome.rule, sourceMailboxId, text),
      tertiaryAction: plan.ids.length > 0
        ? {
            label: text.notifications('rule_apply_existing', { count: plan.ids.length }),
            onClick: () => { void applyAndReport(target, added, sourceMailboxId, text); },
          }
        : undefined,
    },
  );
}

/**
 * Save the rule editor. "Create rule…" puts the rule at the top of the
 * account's rules as the user built it (no merging); an edit replaces the
 * rule in place.
 */
export async function saveEditorRule(
  editor: QuickRuleEditor,
  rule: FilterRule,
  applyToExisting: boolean,
  text: QuickRuleText,
): Promise<void> {
  const { target, sourceMailboxId } = editor;
  let change: FiltersChange | null;
  try {
    change = await updateAccountFilters(target.client, target.sieveAccountId, (rules) =>
      editor.mode === 'edit' ? replaceOrInsertRule(rules, rule) : insertRuleAtTop(rules, rule));
  } catch (error) {
    reportWriteError(error, target, text);
    return;
  }
  if (!change) return;
  useQuickRuleStore.getState().setStatus(target.key, 'ready');
  refreshFilterStore(target);

  if (editor.mode === 'edit') {
    toast.success(text.notifications('filters_saved'));
    return;
  }

  let applied: number | null = null;
  if (applyToExisting) {
    try {
      applied = await applyRuleToExisting(target, rule, sourceMailboxId);
    } catch (error) {
      toast.error(text.notifications('rule_apply_failed'), error instanceof Error ? error.message : undefined);
    }
  }
  toast.success(text.notifications('rule_created'), {
    message: applied !== null ? text.notifications('rule_applied', { count: applied }) : rule.name,
    duration: SAVED_TOAST_MS,
    action: undoAction(target, change, text),
    secondaryAction: editAction(target, rule, sourceMailboxId, text),
  });
}

/** Create the folder the user named, then save the preset that files into it. */
export async function createFolderAndRunPreset(
  request: NewFolderRequest,
  name: string,
  text: QuickRuleText,
): Promise<void> {
  const { target } = request;
  let created;
  try {
    created = await target.client.createMailbox(name.trim());
  } catch (error) {
    toast.error(text.notifications('rule_folder_failed'), error instanceof Error ? error.message : undefined);
    return;
  }
  // The sidebar of the account on screen; other accounts follow their push.
  const email = useEmailStore.getState();
  if (useAuthStore.getState().client === target.client && !email.viewingAccountId) {
    void email.fetchMailboxes(target.client);
  }
  const mailbox = { id: created.id, path: created.name, name: created.name };
  await runPresetRule({
    target,
    preset: request.preset(mailbox),
    subject: request.subject,
    sourceMailboxId: request.sourceMailboxId,
    text,
  });
}

/** Settings › Filters for the account of the message; switches login first when it is another one. */
export async function openFilterSettings(target: QuickRuleTarget, navigate: (href: string) => void): Promise<void> {
  const auth = useAuthStore.getState();
  const login = target.clientAccountId;
  if (login && login !== auth.activeAccountId && auth.getClientForAccount(login) === target.client) {
    await auth.switchAccount(login);
  }
  navigate(buildSettingsPath('filters'));
}
