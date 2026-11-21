'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { cn } from '@/lib/utils';
import { TEAM_LIST_FILTERS, toggleTeamListFilter, useTeamListFilter, type TeamListFilterKey } from '@/lib/team-mailboxes/list-filter';
import { useTeamOf } from './use-team';

const LABEL_KEY: Record<TeamListFilterKey, string> = {
  open: 'filter_open',
  mine: 'filter_mine',
  mentions: 'filter_mentions',
  notes: 'filter_notes',
};

/**
 * Open, Assigned to me, Mentions me and With notes, as chips above the list
 * of a team mailbox's folder. One at a time: a chip is pressed while its
 * filter is on and shows a cross; a click on it again shows everything.
 * `onChange` loads the list again.
 */
export function TeamListFilters({ loginId, accountId, onChange, className }: {
  /** The login the folder is read through. */
  loginId: string | null | undefined;
  /** The folder's JMAP account (its owner); undefined for the user's own folders. */
  accountId: string | null | undefined;
  onChange: () => void;
  className?: string;
}) {
  const t = useTranslations('team_mailboxes');
  const tPlugin = useTranslations('plugin_list');
  const context = useTeamOf(loginId && accountId ? { sourceClientAccountId: loginId, sourceAccountId: accountId } : null);
  const active = useTeamListFilter((s) => s.active);
  const teamKey = context?.ref.key ?? null;
  const on = active && active.teamKey === teamKey ? active.key : null;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seen = useRef(on);
  useEffect(() => {
    if (seen.current === on) return;
    seen.current = on;
    onChangeRef.current();
  }, [on]);

  if (!context) return null;
  return (
    <div
      role="group"
      aria-label={t('filter_label')}
      data-testid="team-list-filters"
      className={cn('flex items-center gap-2 overflow-x-auto border-b border-border px-4 py-1.5 mobile-scroll-hidden', className)}
    >
      {TEAM_LIST_FILTERS.map((key) => {
        const pressed = on === key;
        const label = t(LABEL_KEY[key]);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            title={pressed ? tPlugin('remove_filter', { label }) : undefined}
            onClick={() => toggleTeamListFilter(context.ref.key, key)}
            data-team-filter={key}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors min-h-8',
              pressed ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {label}
            {pressed && <X className="h-3 w-3" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
