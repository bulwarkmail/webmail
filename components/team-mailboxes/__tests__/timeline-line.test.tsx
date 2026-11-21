import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import { TimelineLine } from '../note-cards';

// The grey lines in a conversation, now that several people can have a
// message: taking yourself off reads differently from taking someone else off.

const line = (kind: NoteEntry['kind'], mentions: string[], authorId = 'ca'): NoteEntry => ({
  id: `n-${kind}-${mentions.join('')}`, messageId: null, key: 'k', threadId: null, kind,
  author: { name: 'Alice Archer', email: 'alice@example.org', id: authorId }, at: 1, mentions,
});
const names: Record<string, string> = { ca: 'Alice Archer', cj: 'Josh Jones' };
const nameOf = (id: string) => names[id] ?? null;
const text = (note: NoteEntry) => {
  const { unmount } = render(<ul><TimelineLine note={note} nameOf={nameOf} /></ul>);
  const out = screen.getByRole('listitem').firstChild?.textContent;
  unmount();
  return out;
};

describe('timeline lines', () => {
  it('tells taking yourself off, taking someone else off and taking everyone off apart', () => {
    expect(text(line('unassigned', ['ca']))).toBe('timeline_left');
    expect(text(line('unassigned', ['cj']))).toBe('timeline_unassigned_person');
    expect(text(line('unassigned', []))).toBe('timeline_unassigned');
  });

  it('tells taking a message from assigning it to someone else', () => {
    expect(text(line('assigned', ['ca']))).toBe('timeline_took');
    expect(text(line('assigned', ['cj']))).toBe('timeline_assigned');
  });

  it('goes by the name for notes written before they carried the writer\'s id', () => {
    const old = (mentions: string[]) => ({ ...line('unassigned', mentions), author: { name: 'Alice Archer', email: 'alice@example.org' } });
    expect(text(old(['ca']))).toBe('timeline_left');
    expect(text(old(['cj']))).toBe('timeline_unassigned_person');
  });
});
