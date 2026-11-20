'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import type { Email } from '@/lib/jmap/types';
import { MessageSquare } from '@/components/icons';
import { cn } from '@/lib/utils';
import { noteKeyFor } from '@/lib/team-mailboxes/note-format';
import { rowNotesInfo, useTeamMailboxStore } from '@/stores/team-mailbox-store';
import { useTeamOf, useTeamState } from './use-team';

/**
 * What a list row of a team mailbox shows about its conversation: a speech
 * bubble with the number of notes, and a dot while one of them is new to the
 * user. Nothing outside team mailboxes, nothing for a conversation without
 * notes.
 */
export const TeamRowBadges = memo(function TeamRowBadges({ email, className }: {
  email: Pick<Email, 'id' | 'threadId' | 'messageId' | 'sourceClientAccountId' | 'sourceAccountId'>;
  className?: string;
}) {
  const t = useTranslations('team_mailboxes');
  const context = useTeamOf(email);
  const team = useTeamState(context?.ref.key);
  // The dot follows the user's seen map as well as the notes.
  useTeamMailboxStore((s) => (context ? s.seen[context.ref.loginId] : undefined));
  if (!context || !team) return null;
  const info = rowNotesInfo(team, email.threadId, noteKeyFor(email, context.ref.accountId));
  if (info.count === 0) return null;
  const label = info.unseen ? t('row_count_new', { count: info.count }) : t('summary_count', { count: info.count });
  return (
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
  );
});
