import type { FilterAction, FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { toast } from '@/stores/toast-store';
import { executePlan } from './quick-rule-flow';
import type { QuickRuleTarget } from './quick-rule-target';
import type { RetroPlan, RetroStep } from './retroactive';
import { findRuleMatches } from './rule-preview';

export type ApplyScope = 'new' | 'folder' | 'all';

export const APPLY_LIMIT = Number.MAX_SAFE_INTEGER;

type Matched = Record<string, unknown>;

function filesWithoutFolder(action: FilterAction): boolean {
  return (action.type === 'move' || action.type === 'copy') && !action.mailboxId;
}

function changesOldMail(action: FilterAction): boolean {
  switch (action.type) {
    case 'mark_read':
    case 'star':
    case 'discard':
      return true;
    case 'add_label':
      return !!action.value;
    case 'move':
    case 'copy':
      return !!action.mailboxId;
    default:
      return false;
  }
}

export function appliesToExisting(rule: Pick<FilterRule, 'actions'> & { conditions?: FilterRule['conditions'] }): boolean {
  if (rule.conditions?.some((c) => c.field === 'body')) return false;
  return rule.actions.some(changesOldMail) && !rule.actions.some(filesWithoutFolder);
}

export function skipsJunk(rule: Pick<FilterRule, 'actions' | 'includeSpam'>): boolean {
  return !rule.includeSpam && rule.actions.some((a) => a.type === 'move' || a.type === 'copy');
}

export function planMatched(rule: FilterRule, records: Matched[], mailboxes: Mailbox[]): RetroPlan {
  const serverId = (id: string) => {
    const mailbox = mailboxes.find((m) => m.id === id);
    return mailbox ? mailbox.originalId || mailbox.id : id;
  };
  const messages = records.map((r) => ({
    id: String(r.id),
    mailboxIds: (r.mailboxIds as Record<string, boolean> | undefined) ?? {},
    keywords: (r.keywords as Record<string, boolean> | undefined) ?? {},
  }));
  const steps: RetroStep[] = [];
  const changed = new Set<string>();
  const add = (step: RetroStep) => {
    if (step.ids.length === 0) return;
    steps.push(step);
    for (const id of step.ids) changed.add(id);
  };
  const lacking = (keyword: string) => messages.filter((m) => !m.keywords[keyword]).map((m) => m.id);
  const notIn = (mailboxId: string) => messages.filter((m) => !m.mailboxIds[serverId(mailboxId)]).map((m) => m.id);

  for (const action of rule.actions) {
    if (action.type === 'mark_read') add({ kind: 'mark_read', ids: lacking('$seen') });
    if (action.type === 'star') add({ kind: 'keyword', ids: lacking('$flagged'), keyword: '$flagged' });
    if (action.type === 'add_label' && action.value) add({ kind: 'keyword', ids: lacking(`$label:${action.value}`), keyword: `$label:${action.value}` });
  }
  const filing = rule.actions.filter((a) => (a.type === 'move' || a.type === 'copy') && a.mailboxId);
  const firstMove = filing.find((a) => a.type === 'move');
  const moved = new Set(firstMove ? notIn(firstMove.mailboxId!) : []);
  if (firstMove) add({ kind: 'move', ids: [...moved], mailboxId: firstMove.mailboxId! });
  for (const action of filing) {
    if (action === firstMove) continue;
    const target = action.mailboxId!;
    const ids = messages
      .filter((m) => (moved.has(m.id) ? serverId(target) !== serverId(firstMove!.mailboxId!) : !m.mailboxIds[serverId(target)]))
      .map((m) => m.id);
    add({ kind: 'copy', ids, mailboxId: target });
  }
  const trash = mailboxes.find((m) => m.role === 'trash');
  if (trash && rule.actions.some((a) => a.type === 'discard')) add({ kind: 'move', ids: notIn(trash.id), mailboxId: trash.id });
  return { ids: [...changed], steps };
}

export async function applyRuleToScope(
  target: QuickRuleTarget,
  rule: FilterRule,
  scope: ApplyScope,
  folderId: string | null,
): Promise<number | null> {
  if (scope === 'new' || !appliesToExisting(rule)) return 0;
  if (scope === 'folder' && !folderId) return 0;
  const matches = await findRuleMatches(target, rule, {
    folderId: scope === 'folder' ? folderId! : undefined,
    skipJunk: skipsJunk(rule),
    limit: APPLY_LIMIT,
  });
  if (!matches) return 0;
  const plan = planMatched(rule, matches.records, target.mailboxes);
  if (!(await executePlan(target, plan))) return null;
  return plan.ids.length;
}

export interface ScopeText {
  running: (name: string) => string;
  applied: (count: number) => string;
  failed: string;
}

export async function runRuleOnScope(
  target: QuickRuleTarget,
  rule: FilterRule,
  scope: ApplyScope,
  folderId: string | null,
  text: ScopeText,
): Promise<void> {
  if (scope === 'new') return;
  const progressId = toast.progress(text.running(rule.name), { progress: null });
  try {
    const count = await applyRuleToScope(target, rule, scope, folderId);
    toast.dismiss(progressId);
    if (count !== null) toast.success(text.applied(count), { message: rule.name });
  } catch (error) {
    toast.dismiss(progressId);
    toast.error(text.failed, error instanceof Error ? error.message : undefined);
  }
}
