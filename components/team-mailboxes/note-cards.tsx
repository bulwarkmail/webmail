'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Avatar } from '@/components/ui/avatar';
import { LinkifiedText } from '@/components/ui/linkified-text';
import { Lock, RotateCcw, Trash2 } from '@/components/icons';
import { cn } from '@/lib/utils';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import type { PendingNote } from '@/stores/team-mailbox-store';

/** A person's name as notes show it: the name, else the address's local part. */
export function displayName(author: { name?: string; email: string }): string {
  return author.name?.trim() || author.email.split('@')[0];
}

/** "14:02" today, else "20 Nov, 14:02" (with the year when it isn't this year). */
export function noteTime(at: number, locale: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (sameDay) return time;
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  }).format(date);
  return `${day}, ${time}`;
}

function fullTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(at));
}

interface NoteCardProps {
  note: NoteEntry;
  /** Shown only on the user's own notes. */
  onDelete?: () => void;
  /** The note a notification pointed at. */
  highlighted?: boolean;
}

/** One note: avatar, name, time, text (links clickable, never HTML). */
export function NoteCard({ note, onDelete, highlighted }: NoteCardProps) {
  const t = useTranslations('team_mailboxes');
  const locale = useLocale();
  const name = displayName(note.author);
  const time = noteTime(note.at, locale);
  return (
    <li
      className={cn(
        'flex gap-3 rounded-lg border border-note-border bg-note text-note-foreground px-3 py-2.5',
        highlighted && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
      )}
      aria-label={t('note_from', { name, time })}
      data-team-note={note.id}
      tabIndex={-1}
    >
      <Avatar name={name} email={note.author.email} size="sm" disableFavicon className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{name}</span>
          <time className="shrink-0 text-xs opacity-75" dateTime={new Date(note.at).toISOString()} title={fullTime(note.at, locale)}>{time}</time>
        </div>
        <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm">
          {note.text === undefined
            ? <span className="inline-block h-3 w-40 max-w-full animate-pulse rounded bg-note-foreground/15 align-middle" aria-hidden="true" />
            : <LinkifiedText text={note.text} />}
        </p>
      </div>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="-me-1 -mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md opacity-70 hover:bg-note-foreground/10 hover:opacity-100 focus-visible:opacity-100"
          aria-label={t('delete')}
          title={t('delete')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

/** A note on its way to the server, or one that couldn't be saved (with Retry). */
export function PendingNoteCard({ pending, author, onRetry, onEdit }: {
  pending: PendingNote;
  author: { name: string; email: string };
  onRetry: () => void;
  /** Takes the card away and puts its text back into the note field. */
  onEdit?: () => void;
}) {
  const t = useTranslations('team_mailboxes');
  const tCommon = useTranslations('common');
  const name = displayName(author);
  const failed = pending.status === 'error';
  return (
    <li
      className={cn('flex gap-3 rounded-lg border bg-note text-note-foreground px-3 py-2.5', failed ? 'border-destructive' : 'border-note-border opacity-80')}
      aria-label={t('note_from', { name, time: failed ? t('save_failed') : t('sending') })}
      data-team-note-pending={pending.localId}
    >
      <Avatar name={name} email={author.email} size="sm" disableFavicon className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="shrink-0 text-xs opacity-75">{failed ? null : t('sending')}</span>
        </div>
        <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm">{pending.text}</p>
        {failed && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" role="alert">
            <span className="text-destructive">{pending.error === 'overQuota' ? t('full') : pending.error === 'forbidden' ? t('read_only') : pending.error === 'offline' ? t('offline') : t('save_failed')}</span>
            {pending.error !== 'forbidden' && pending.error !== 'overQuota' && (
              <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-md border border-note-border px-2 py-1 font-medium hover:bg-note-foreground/10">
                <RotateCcw className="h-3.5 w-3.5" />
                {t('retry')}
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-note-border px-2 py-1 font-medium hover:bg-note-foreground/10">
                {tCommon('edit')}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** A timeline entry: one grey line, "Linus assigned this to Josh". */
export function TimelineLine({ note, nameOf }: { note: NoteEntry; nameOf: (principalId: string) => string | null }) {
  const t = useTranslations('team_mailboxes');
  const locale = useLocale();
  const name = displayName(note.author);
  const assignee = note.mentions[0] ? nameOf(note.mentions[0]) : null;
  const text = note.kind === 'assigned'
    ? (assignee && assignee === name ? t('timeline_took', { name }) : t('timeline_assigned', { name, assignee: assignee ?? t('someone') }))
    : note.kind === 'unassigned' ? t('timeline_unassigned', { name })
      : note.kind === 'done' ? t('timeline_done', { name })
        : t('timeline_reopened', { name });
  return (
    <li className="flex items-center justify-center gap-2 px-2 py-1 text-center text-xs text-muted-foreground" data-team-timeline={note.id}>
      <span>{text}</span>
      <time className="opacity-75" dateTime={new Date(note.at).toISOString()} title={fullTime(note.at, locale)}>· {noteTime(note.at, locale)}</time>
    </li>
  );
}

/** "Only your team sees this", above the first notes of a conversation. */
export function TeamOnlyLine() {
  const t = useTranslations('team_mailboxes');
  return (
    <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" data-team-only="">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t('team_only')}
    </p>
  );
}
