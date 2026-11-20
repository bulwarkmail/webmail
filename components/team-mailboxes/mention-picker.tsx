'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { insertMention, mentionCandidates, mentionQueryAt, type MentionCandidate, type PickedMention } from '@/lib/team-mailboxes/mentions';

/**
 * The @ list of the note field: while the user types @ and a few letters,
 * the team's people that fit show under the field. Up and Down move, Enter
 * or Tab pick, Escape closes the list only; a tap or click picks. The field
 * is a combobox for screen readers while the list is open.
 */
export function useMentionPicker({ people, selfId, text, setText }: {
  people: readonly MentionCandidate[];
  selfId: string | null;
  text: string;
  setText: (text: string, caret: number) => void;
}) {
  const t = useTranslations('team_mailboxes');
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const at = mentionQueryAt(text, caret);
  const candidates = useMemo(() => (at ? mentionCandidates(people, at.query, selfId) : []), [at?.query, at?.start, people, selfId]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = !!at && candidates.length > 0 && closedAt !== at.start;
  const current = Math.min(active, Math.max(0, candidates.length - 1));

  const pick = useCallback((person: MentionCandidate) => {
    if (!at) return;
    const out = insertMention(text, at, person);
    setPicked((list) => [...list.filter((p) => p.id !== out.picked.id), out.picked]);
    // This @ is done: typing on after the name doesn't open the list again.
    setClosedAt(at.start);
    setText(out.text, out.caret);
    setCaret(out.caret);
    setActive(0);
  }, [at, text, setText]);

  /** Keys for the field; true when the list took the key. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      pick(candidates[current]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setClosedAt(at!.start);
      return true;
    }
    return false;
  }, [open, candidates, current, pick, at]);

  const optionId = (i: number) => `${listId}-${i}`;
  const fieldProps: React.TextareaHTMLAttributes<HTMLTextAreaElement> = {
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-autocomplete': 'list',
    'aria-activedescendant': open ? optionId(current) : undefined,
    onSelect: (event) => setCaret(event.currentTarget.selectionStart ?? 0),
    onKeyUp: (event) => setCaret(event.currentTarget.selectionStart ?? 0),
    onClick: (event) => setCaret(event.currentTarget.selectionStart ?? 0),
  };

  const list = open ? (
    <ul
      id={listId}
      role="listbox"
      aria-label={t('mention_list')}
      className="absolute inset-x-2 bottom-full z-20 mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      data-team-mention-list=""
    >
      {candidates.map((person, i) => (
        <li
          key={person.id}
          id={optionId(i)}
          role="option"
          aria-selected={i === current}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(person)}
          onMouseMove={() => { if (i !== current) setActive(i); }}
          className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5', i === current && 'bg-muted')}
        >
          <span aria-hidden="true" className="shrink-0"><Avatar name={person.name} email={person.email} size="sm" disableFavicon /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{person.name || person.email}</span>
            {person.name && <span className="block truncate text-xs text-muted-foreground">{person.email}</span>}
          </span>
        </li>
      ))}
    </ul>
  ) : null;

  /** After the note was saved: start over. */
  const reset = useCallback(() => {
    setPicked([]);
    setClosedAt(null);
    setActive(0);
  }, []);

  return { list, fieldProps, onKeyDown, picked, reset, setCaret };
}
