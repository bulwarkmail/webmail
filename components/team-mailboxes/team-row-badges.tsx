'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { Email } from '@/lib/jmap/types';
import { MessageSquare } from '@/components/icons';
import { cn } from '@/lib/utils';
import { noteKeyFor } from '@/lib/team-mailboxes/note-format';
import { rowNotesInfo, useTeamMailboxStore } from '@/stores/team-mailbox-store';
import { useTeamPeople } from '@/hooks/use-team-people';
import { AssigneeChip, DoneMark } from './assignee-chip';
import { useTeamOf, useTeamState } from './use-team';

type RowEmail = Pick<Email, 'id' | 'threadId' | 'messageId' | 'keywords' | 'sourceClientAccountId' | 'sourceAccountId'>;

/**
 * What a list row of a team mailbox shows: who the message is assigned to,
 * a Done mark, and a speech bubble with the number of notes of its
 * conversation, with a dot while one of them is new to the user. Nothing
 * outside team mailboxes.
 */
export const TeamRowBadges = memo(function TeamRowBadges({ email, className }: { email: RowEmail; className?: string }) {
  const context = useTeamOf(email);
  if (!context) return null;
  return <TeamRowBadgesInner email={email} context={context} className={className} />;
});

function TeamRowBadgesInner({ email, context, className }: {
  email: RowEmail;
  context: NonNullable<ReturnType<typeof useTeamOf>>;
  className?: string;
}) {
  const t = useTranslations('team_mailboxes');
  const team = useTeamState(context.ref.key);
  const people = useTeamPeople(context.ref, context.client);
  // The dot follows the user's seen map as well as the notes.
  useTeamMailboxStore((s) => s.seen[context.ref.loginId]);
  const info = team ? rowNotesInfo(team, email.threadId, noteKeyFor(email, context.ref.accountId)) : { count: 0, unseen: false };
  const label = info.unseen ? t('row_count_new', { count: info.count }) : t('summary_count', { count: info.count });
  return (
    <>
      <AssigneeChip keywords={email.keywords} people={people} className="ms-1.5 shrink-0 align-middle" />
      <DoneMark keywords={email.keywords} className="ms-1.5 shrink-0 align-middle" />
      {info.count > 0 && (
        <span
          className={cn('ms-1.5 inline-flex shrink-0 items-center gap-0.5 align-middle text-xs text-muted-foreground', className)}
          title={label}
          aria-label={label}
          role="img"
          data-team-row-notes={info.count}
          data-team-row-unseen={info.unseen ? '' : undefined}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          <span aria-hidden="true">{info.count}</span>
          {info.unseen && <span className="ms-0.5 h-2 w-2 rounded-full bg-unread" aria-hidden="true" />}
        </span>
      )}
    </>
  );
}
