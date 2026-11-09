import { describe, expect, it } from 'vitest';
import { accountRowText } from '../account-utils';

function account(id: string, displayName: string, email: string) {
  return { id, displayName, label: email, email, username: email };
}

describe('accountRowText', () => {
  it('shows the name over the address when the name is unique', () => {
    const work = account('w', 'Nora Lindqvist', 'nora@meridianlabs.example');
    const other = account('o', 'Sarah Kim', 'sarah@example.com');
    expect(accountRowText(work, [work, other])).toEqual({
      title: 'Nora Lindqvist',
      subtitle: 'nora@meridianlabs.example',
    });
  });

  it('leads with the address alone when another account has the same name', () => {
    const work = account('w', 'Nora Lindqvist', 'nora@meridianlabs.example');
    const home = account('h', ' nora lindqvist', 'nora@lindqvist.example');
    expect(accountRowText(work, [work, home])).toEqual({ title: 'nora@meridianlabs.example', subtitle: null });
    expect(accountRowText(home, [work, home])).toEqual({ title: 'nora@lindqvist.example', subtitle: null });
  });

  it('does not repeat the address when the label is the address', () => {
    const bare = { id: 'b', displayName: '', label: 'Bare@Example.com', email: 'bare@example.com', username: 'bare@example.com' };
    expect(accountRowText(bare, [bare])).toEqual({ title: 'bare@example.com', subtitle: null });
  });
});
