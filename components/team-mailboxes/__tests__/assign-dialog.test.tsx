import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import { resetTeamNames, useTeamNamesStore } from '@/lib/team-mailboxes/names';
import { resetTeamMailboxStore, useTeamMailboxStore, type TeamState } from '@/stores/team-mailbox-store';
import { isKeyboardLayerOpen } from '@/lib/keyboard';
import { AssignDialog, DIRECTORY_SEARCH_DELAY_MS } from '../assign-dialog';

vi.mock('@/components/ui/avatar', () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock('@/lib/directory-scope', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/directory-scope')>();
  return { ...real, loadScopedPrincipalDirectory: vi.fn(async () => ({ principals: [], status: 'ok' })) };
});
const scope = await import('@/lib/directory-scope');

const ref: TeamRef = { key: 'login|g', loginId: 'login', accountId: 'g', groupAddress: 'tm-team@example.org' };
const client = {
  getUsername: () => 'tm-alice@example.org',
  getAccountId: () => 'ca',
  supportsPrincipals: () => true,
  supportsBulwarkMetadata: () => false,
} as unknown as IJMAPClient;

const assigned = (id: string, mention: string, at: number): NoteEntry => ({
  id, messageId: null, key: 'k', threadId: null, kind: 'assigned', author: { name: 'Mabel Moss', email: 'mabel@example.org' }, at, mentions: [mention],
});

function seed() {
  useTeamMailboxStore.setState({
    teams: {
      [ref.key]: {
        ref, status: 'ready', folderIds: ['notes'], canWrite: true, author: { name: 'Alice Archer', email: 'tm-alice@example.org' },
        windowStart: 0, notes: { n1: assigned('n1', 'cm', 1), n2: assigned('n2', 'cm', 2) }, pending: {}, conversations: {}, version: 1,
      } as TeamState,
    },
  });
  useTeamNamesStore.setState({
    lists: {
      [ref.key]: {
        cj: { name: 'Josh Jones', email: 'josh@example.org' },
        cm: { name: 'Mabel Moss', email: 'mabel@example.org' },
      },
    },
    directory: {},
  });
}

function Harness({ onSave, assigned = [] }: { onSave: (ids: string[], people: Record<string, unknown>) => void; assigned?: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Assign to…</button>
      <AssignDialog isOpen={open} onClose={() => setOpen(false)} onSave={onSave} assigned={assigned} team={ref} client={client} />
    </>
  );
}

function openDialog(onSave = vi.fn(), assigned: string[] = []) {
  render(<Harness onSave={onSave} assigned={assigned} />);
  const opener = screen.getByRole('button', { name: 'Assign to…' });
  opener.focus();
  fireEvent.click(opener);
  return { onSave, opener };
}

const options = () => within(screen.getByRole('listbox', { name: 'people' })).getAllByRole('option').map((o) => o.textContent);
const ticked = () => screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent);

beforeEach(() => {
  resetTeamMailboxStore();
  resetTeamNames();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  resetTeamMailboxStore();
  resetTeamNames();
});

describe('Assign to…', () => {
  it('is a dialog titled Assign to with a labelled search field, you first, then recent assignees and the team', () => {
    openDialog();
    const dialog = screen.getByRole('dialog', { name: 'dialog_title' });
    const field = within(dialog).getByRole('combobox', { name: 'search_label' });
    expect(document.activeElement).toBe(field);
    expect(within(dialog).getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    expect(options()).toEqual([
      'Alice Archer(you)tm-alice@example.org',
      'Mabel Mossmabel@example.org',
      'Josh Jonesjosh@example.org',
    ]);
    expect(screen.getAllByTestId('avatar')).toHaveLength(3);
  });

  it('ticks several people with clicks, unticks with a second click, and Save hands over everyone ticked', () => {
    const { onSave, opener } = openDialog();
    fireEvent.click(screen.getByRole('option', { name: /Josh Jones/ }));
    fireEvent.click(screen.getByRole('option', { name: /Mabel Moss/ }));
    fireEvent.click(screen.getByRole('option', { name: /Alice Archer/ }));
    fireEvent.click(screen.getByRole('option', { name: /Josh Jones/ }));
    expect(ticked()).toEqual(['Alice Archer(you)tm-alice@example.org', 'Mabel Mossmabel@example.org']);
    // Ticking alone changes nothing yet.
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave).toHaveBeenCalledWith(['cm', 'ca'], {
      cm: { id: 'cm', name: 'Mabel Moss', email: 'mabel@example.org' },
      ca: { id: 'ca', name: 'Alice Archer', email: 'tm-alice@example.org' },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('opens with the people the message has ticked, and keeps one nobody named', () => {
    const { onSave } = openDialog(vi.fn(), ['cm', 'zz']);
    expect(ticked()).toEqual(['Mabel Mossmabel@example.org', 'assigned_unknown']);
    fireEvent.click(screen.getByRole('option', { name: /Mabel Moss/ }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave).toHaveBeenCalledWith(['zz'], {});
  });

  it('moves with the arrow keys, ticks with Enter and saves with Ctrl+Enter', () => {
    const { onSave } = openDialog();
    const field = screen.getByRole('combobox');
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2].id);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(ticked()).toEqual(['Mabel Mossmabel@example.org']);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith(['cm'], expect.objectContaining({ cm: expect.objectContaining({ name: 'Mabel Moss' }) }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters by name or address as the user types, and says when no one matches', () => {
    openDialog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'JOSH@' } });
    expect(options()).toEqual(['Josh Jonesjosh@example.org']);
    fireEvent.change(field, { target: { value: 'zz' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('no_one_found');
  });

  it('ticks the first directory match with Enter after the arrow keys were used on an empty list, and keeps its name', async () => {
    vi.useFakeTimers();
    vi.mocked(scope.loadScopedPrincipalDirectory).mockResolvedValue({
      principals: [{ id: 'cx', type: 'individual', name: 'xavier', description: 'Xavier Xu', email: 'xavier@example.org' }],
      status: 'ok',
    });
    const { onSave } = openDialog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'xav' } });
    // Waiting for the directory: no "No one found." yet.
    expect(screen.getByRole('status')).not.toHaveTextContent('no_one_found');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIRECTORY_SEARCH_DELAY_MS + 50); });
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
    fireEvent.keyDown(field, { key: 'Enter' });
    // Another search: the ticked person is still named on Save.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(onSave).toHaveBeenCalledWith(['cx'], { cx: { id: 'cx', name: 'Xavier Xu', email: 'xavier@example.org' } });
  });

  it('adds directory matches from 3 characters, after a pause', async () => {
    vi.useFakeTimers();
    vi.mocked(scope.loadScopedPrincipalDirectory).mockResolvedValue({
      principals: [
        { id: 'cx', type: 'individual', name: 'xavier', description: 'Xavier Xu', email: 'xavier@example.org' },
        { id: 'g', type: 'group', name: 'xteam', email: 'xteam@example.org' },
      ],
      status: 'ok',
    });
    openDialog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'xa' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIRECTORY_SEARCH_DELAY_MS * 2); });
    expect(scope.loadScopedPrincipalDirectory).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'xav' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIRECTORY_SEARCH_DELAY_MS - 50); });
    expect(scope.loadScopedPrincipalDirectory).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(options()).toEqual(['Xavier Xuxavier@example.org']);
  });

  it('closes with Escape without saving, and keeps the key from the mail shortcuts', () => {
    const { onSave, opener } = openDialog();
    fireEvent.click(screen.getByRole('option', { name: /Josh Jones/ }));
    // The modal dialog owns the keyboard: the mail shortcuts check this (lib/keyboard.ts).
    expect(isKeyboardLayerOpen()).toBe(true);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(isKeyboardLayerOpen()).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes with Cancel', () => {
    const { onSave } = openDialog();
    fireEvent.click(screen.getByRole('option', { name: /Josh Jones/ }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('leaves out people it has no name or address for', () => {
    useTeamMailboxStore.setState((s) => ({
      teams: { [ref.key]: { ...s.teams[ref.key], notes: { n3: { ...assigned('n3', 'zz', 3), author: { name: '', email: 'tm-alice@example.org' } } } } },
    }));
    openDialog();
    expect(options()).toEqual(['Alice Archer(you)tm-alice@example.org', 'Josh Jonesjosh@example.org', 'Mabel Mossmabel@example.org']);
  });
});
