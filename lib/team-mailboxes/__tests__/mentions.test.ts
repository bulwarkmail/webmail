import { describe, expect, it } from 'vitest';
import { insertMention, mentionCandidates, mentionQueryAt, mentionsIn } from '../mentions';

const people = [
  { id: 'hv', name: 'Bob Baker', email: 'tm-bob@example.org' },
  { id: 'hw', name: 'Carol Cooper', email: 'tm-carol@example.org' },
  { id: 'me', name: 'Alice Archer', email: 'tm-alice@example.org' },
  { id: 'hx', name: '', email: 'rita@example.org' },
];

describe('mentions in a note', () => {
  it('finds the @ being typed at the caret, only at a word start', () => {
    expect(mentionQueryAt('ask @ca', 7)).toEqual({ start: 4, query: 'ca' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail a@b', 8)).toBeNull();
    expect(mentionQueryAt('@carol\nnext', 11)).toBeNull();
    expect(mentionQueryAt('no at', 5)).toBeNull();
  });

  it('offers the team without the user, best match first', () => {
    expect(mentionCandidates(people, 'c', 'me').map((p) => p.id)).toEqual(['hw']);
    expect(mentionCandidates(people, 'ba', 'me').map((p) => p.id)).toEqual(['hv']);
    expect(mentionCandidates(people, '', 'me').map((p) => p.id)).toEqual(['hv', 'hw', 'hx']);
    expect(mentionCandidates(people, 'rita', 'me').map((p) => p.id)).toEqual(['hx']);
    expect(mentionCandidates(people, 'zz', 'me')).toEqual([]);
  });

  it('puts the name in and keeps what follows', () => {
    const out = insertMention('ask @ca about it', { start: 4, query: 'ca' }, people[1]);
    expect(out.text).toBe('ask @Carol Cooper about it');
    expect(out.caret).toBe(18);
    expect(out.picked).toEqual({ id: 'hw', label: 'Carol Cooper' });
  });

  it('stores only people still named in the text and known to the team', () => {
    const picked = [{ id: 'hv', label: 'Bob Baker' }, { id: 'hw', label: 'Carol Cooper' }, { id: 'zz', label: 'Zed' }];
    const team = new Set(['hv', 'hw']);
    expect(mentionsIn('thanks @Bob Baker and @Zed', picked, team)).toEqual(['hv']);
    expect(mentionsIn('nobody', picked, team)).toEqual([]);
  });
});
