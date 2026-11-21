'use client';

/**
 * Assign to me, Assign to…, Unassign, Mark done and Reopen for a message of
 * a team mailbox: one list of entries every surface shows (reader toolbar,
 * the ⋮ menu, the row's right-click / long-press menu, hover buttons), each
 * only where it applies, and only where the message's folder lets the user
 * change it. Every change ends in a toast with Undo, or in "Couldn't change
 * the message. Try again."
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { create } from 'zustand';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { CheckCircle, RotateCcw, UserCheck, UserMinus, UserPlus } from '@/components/icons';
import { toast } from '@/stores/toast-store';
import { toastWithUndo } from '@/lib/email-action-toast';
import { emailKeyFor } from '@/lib/thread-utils';
import { useEmailStore } from '@/stores/email-store';
import { assignedTo, assigneesOf, isDone } from '@/lib/team-mailboxes/keywords';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import type { Person } from '@/lib/team-mailboxes/names';
import {
  assignToMe,
  markDone,
  reopen,
  setAssignees,
  unassign,
  unassignPerson,
  type AssignableEmail,
  type AssignmentResult,
} from '@/stores/team-mailbox-store';
import type { MessageActionEntry } from '@/components/email/message-actions';
import { AssignDialog } from './assign-dialog';
import { useTeamOf, type TeamContext } from './use-team';

type ActionEmail = Pick<Email, 'id' | 'threadId' | 'messageId' | 'subject' | 'keywords' | 'mailboxIds' | 'sourceClientAccountId' | 'sourceAccountId'>;

export const TEAM_ACTION_KEYS = {
  assignMe: 'extra:team_assign_me',
  assignTo: 'extra:team_assign_to',
  unassign: 'extra:team_unassign',
  done: 'extra:team_done',
  reopen: 'extra:team_reopen',
} as const;

/** The one Assign to… dialog, opened from any surface. */
interface AssignRequest {
  context: TeamContext;
  email: ActionEmail;
}
const useAssignRequest = create<{ request: AssignRequest | null }>()(() => ({ request: null }));

/**
 * Whether the user may change the message's keywords: not in an account
 * shared read-only, and not where its folder says no.
 */
function maySetKeywords(email: ActionEmail, accountId: string, client: TeamContext['client']): boolean {
  if (client.getAccountInfo?.(accountId)?.isReadOnly === true) return false;
  const ids = Object.keys(email.mailboxIds ?? {}).filter((id) => email.mailboxIds[id]);
  const mailboxes = useEmailStore.getState().mailboxes;
  const folders = mailboxes.filter((m) => m.accountId === accountId && (ids.includes(m.originalId ?? m.id) || ids.includes(m.id)));
  return folders.length === 0 || folders.some((m) => m.myRights?.maySetKeywords !== false);
}

function asAssignable(email: ActionEmail): AssignableEmail {
  const messageId = email.messageId as unknown;
  return {
    id: email.id,
    messageId: Array.isArray(messageId) ? messageId : typeof messageId === 'string' ? [messageId] : null,
    threadId: email.threadId,
    subject: email.subject,
    keywords: email.keywords,
  };
}

function applyRow(context: TeamContext, email: ActionEmail, keywords: Record<string, boolean>): void {
  useEmailStore.getState().setEmailKeywordsLocal(email.id, keywords, emailKeyFor(email), {
    clientAccountId: context.ref.loginId, accountId: context.ref.accountId,
  });
}

/** Runs one change and tells the user; Undo puts the message back as it was. */
export async function run(
  context: TeamContext,
  email: ActionEmail,
  change: () => Promise<AssignmentResult>,
  texts: { done: (r: AssignmentResult) => string; failed: string; undo: string },
): Promise<void> {
  let result: AssignmentResult;
  try {
    result = await change();
  } catch {
    toast.error(texts.failed);
    return;
  }
  if (!result.changed) return;
  applyRow(context, email, result.keywords as Record<string, boolean>);
  const before = { ...(email.keywords ?? {}) };
  toastWithUndo(texts.done(result), {
    label: texts.undo,
    onClick: () => {
      void result.undo()
        .then(() => applyRow(context, email, before))
        .catch(() => toast.error(texts.failed));
    },
  });
}

export function useTexts() {
  const t = useTranslations('team_assign');
  const tTeam = useTranslations('team_mailboxes');
  return useMemo(() => ({
    t,
    failed: t('change_failed'),
    undo: tTeam('undo'),
    doneText: (r: AssignmentResult) => {
      if (r.kind === 'assigned' && (r.added?.length ?? 0) > 1) {
        const names = r.added!.map((p) => (p.me ? t('you') : p.name)).filter(Boolean);
        return names.length === r.added!.length ? t('assigned_to', { name: names.join(', ') }) : t('assignees_changed');
      }
      if (r.kind === 'assigned') return r.assignee?.me ? t('assigned_to_you') : r.assignee?.name ? t('assigned_to', { name: r.assignee.name }) : t('assigned_unknown');
      if (r.kind === 'unassigned' && r.removed && !r.removed.me && r.removed.name) return t('unassigned_person', { name: r.removed.name });
      if (r.kind === 'unassigned') return t('no_longer_assigned');
      if (r.kind === 'done') return t('marked_done');
      return t('reopened');
    },
  }), [t, tTeam]);
}

/**
 * The entries for this message; empty outside a team mailbox with the
 * feature on, and where the folder doesn't let the user change messages.
 */
export function useTeamActions(email: ActionEmail | null | undefined): MessageActionEntry[] {
  const context = useTeamOf(email ?? null);
  const texts = useTexts();
  return useMemo(() => {
    if (!context || !email || !maySetKeywords(email, context.ref.accountId, context.client)) return [];
    const selfId = context.client.getAccountId().toLowerCase();
    const keywords = email.keywords ?? {};
    const mine = assignedTo(keywords, selfId);
    const assigned = assigneesOf(keywords).length > 0;
    const done = isDone(keywords);
    const target = asAssignable(email);
    const go = (change: () => Promise<AssignmentResult>) => () => {
      void run(context, email, change, { done: texts.doneText, failed: texts.failed, undo: texts.undo });
    };
    const entries: MessageActionEntry[] = [];
    if (!mine) entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.assignMe, icon: UserCheck, label: texts.t('assign_to_me'), run: go(() => assignToMe(context.ref.key, target)), testId: 'team-assign-me' });
    entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.assignTo, icon: UserPlus, label: texts.t('assign_to'), run: () => useAssignRequest.setState({ request: { context, email } }), testId: 'team-assign-to' });
    // Several people can have it: Unassign me leaves the others on it.
    if (mine) entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.unassign, icon: UserMinus, label: texts.t('unassign_me'), run: go(() => unassignPerson(context.ref.key, target, selfId)), testId: 'team-unassign' });
    else if (assigned) entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.unassign, icon: UserMinus, label: texts.t('unassign'), run: go(() => unassign(context.ref.key, target)), testId: 'team-unassign' });
    if (!done) entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.done, icon: CheckCircle, label: texts.t('mark_done'), run: go(() => markDone(context.ref.key, target)), testId: 'team-done' });
    else entries.push({ kind: 'item', key: TEAM_ACTION_KEYS.reopen, icon: RotateCcw, label: texts.t('reopen'), run: go(() => reopen(context.ref.key, target)), testId: 'team-reopen' });
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the message's id and keywords
  }, [context, email?.id, JSON.stringify(email?.keywords ?? {}), texts]);
}

/** The Assign to… dialog for whichever surface asked; mounted once in the mail app. */
export function TeamAssignDialogHost() {
  const request = useAssignRequest((s) => s.request);
  const texts = useTexts();
  if (!request) return null;
  const { context, email } = request;
  const close = () => useAssignRequest.setState({ request: null });
  const onSave = (ids: string[], people: Record<string, { name: string; email: string }>) => {
    const named: Record<string, Person> = {};
    for (const [id, p] of Object.entries(people)) named[id] = { name: p.name, email: p.email };
    void run(context, email, () => setAssignees(context.ref.key, asAssignable(email), ids, named), { done: texts.doneText, failed: texts.failed, undo: texts.undo });
  };
  return <AssignDialog isOpen onClose={close} onSave={onSave} assigned={assigneesOf(email.keywords)} team={context.ref} client={context.client as IJMAPClient} />;
}

/** For tests. */
export function resetAssignRequest(): void {
  useAssignRequest.setState({ request: null });
}

export type { TeamRef };
