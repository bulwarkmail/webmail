import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { activeTeamFilterCondition, clearTeamListFilter, teamFilterCondition } from '@/lib/team-mailboxes/list-filter';

// Open, Assigned to me, Mentions me and With notes above a team mailbox's
// list: one at a time, a second click shows everything again.

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
let inTeam = true;
vi.mock('../use-team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-team')>()),
  useTeamOf: () => (inTeam ? { ref, client: { getAccountId: () => 'me' } } : null),
}));
const { TeamListFilters } = await import('../team-list-filters');

afterEach(() => {
  inTeam = true;
  clearTeamListFilter();
});

describe('team list filters', () => {
  it('turns one filter on at a time and off again, reloading the list each time', () => {
    const onChange = vi.fn();
    render(<TeamListFilters loginId="login" accountId="g" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'filter_label' });
    expect(group.querySelectorAll('button')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'filter_mine' }));
    expect(screen.getByRole('button', { name: 'filter_mine' }).getAttribute('aria-pressed')).toBe('true');
    expect(activeTeamFilterCondition(ref.key, 'me')).toEqual({ hasKeyword: '$assigned:me' });
    fireEvent.click(screen.getByRole('button', { name: 'filter_notes' }));
    expect(screen.getByRole('button', { name: 'filter_mine' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'filter_notes' }));
    expect(activeTeamFilterCondition(ref.key, 'me')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('applies only to the team it was picked in, and shows nothing outside a team mailbox', () => {
    render(<TeamListFilters loginId="login" accountId="g" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'filter_open' }));
    expect(activeTeamFilterCondition('login|other', 'me')).toBeNull();
    inTeam = false;
    const { container } = render(<TeamListFilters loginId="login" accountId="h" onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('asks the server about the conversation for notes and mentions', () => {
    expect(teamFilterCondition('open', 'me')).toEqual({ notKeyword: '$done' });
    expect(teamFilterCondition('mentions', 'Me')).toEqual({ someInThreadHaveKeyword: '$bulwark-mention-me' });
    expect(teamFilterCondition('notes', 'me')).toEqual({ someInThreadHaveKeyword: '$bulwark-notes' });
  });
});
