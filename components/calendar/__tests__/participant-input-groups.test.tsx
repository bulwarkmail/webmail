import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantInput } from '../participant-input';
import { useContactStore } from '@/stores/contact-store';
import type { ContactCard } from '@/lib/jmap/types';
import { createDemoContacts } from '@/lib/demo/fixtures/contacts';

beforeEach(() => {
  vi.useFakeTimers();
  useContactStore.setState({ contacts: createDemoContacts(), contactsLoaded: true, directoryPrincipals: [], recentRecipients: [] });
});

afterEach(() => vi.useRealTimers());

function search(query: string, participants: Array<{ name: string; email: string }> = []) {
  const onAdd = vi.fn();
  render(<ParticipantInput participants={participants} onAdd={onAdd} onRemove={vi.fn()} />);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: query } });
  act(() => vi.advanceTimersByTime(200));
  return { input, onAdd };
}

describe('Issue #1505: real contact store and real calendar participant input', () => {
  it('control: clicking an individual contact adds that attendee', () => {
    const { onAdd } = search('Alice');
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].email).toContain('@');
  });

  it('clicking Beacon team adds its five members as attendees', () => {
    const { onAdd } = search('Beacon team');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Beacon team/ }));
    expect(onAdd).toHaveBeenCalledTimes(5);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('selecting Beacon team with the keyboard adds its five members', () => {
    const { input, onAdd } = search('Beacon team');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledTimes(5);
  });

  it('adds the only member of a one-person group', () => {
    const contacts = createDemoContacts();
    const member = contacts.find(c => c.id === 'demo-contact-alice')!;
    const group = contacts.find(c => c.id === 'demo-group-beacon')!;
    useContactStore.setState({ contacts: [member, { ...group, members: { [member.id]: true } }] });
    const { onAdd } = search('Beacon team');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Beacon team/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('marks group suggestions with a translated group label and member count', () => {
    search('Beacon team');
    expect(screen.getByTitle('directory.type.group')).toBeInTheDocument();
    expect(screen.getByText('groups.member_count')).toBeInTheDocument();
  });

  it('adds each usable address once, skipping existing attendees and missing or invalid emails', () => {
    const contacts: ContactCard[] = [
      { addressBookIds: { book: true }, id: 'group', kind: 'group', name: { full: 'Test group' }, members: { a: true, b: true, c: true, d: true, e: true, f: true } },
      { addressBookIds: { book: true }, id: 'a', kind: 'individual', name: { full: 'Existing' }, emails: { e: { address: 'EXISTING@example.com' } } },
      { addressBookIds: { book: true }, id: 'b', kind: 'individual', name: { full: 'New' }, emails: { e: { address: ' new@example.com ' } } },
      { addressBookIds: { book: true }, id: 'c', kind: 'individual', name: { full: 'Duplicate' }, emails: { e: { address: 'NEW@example.com' } } },
      { addressBookIds: { book: true }, id: 'd', kind: 'individual', name: { full: 'Missing' } },
      { addressBookIds: { book: true }, id: 'e', kind: 'individual', name: { full: 'Invalid' }, emails: { e: { address: 'not-an-email' } } },
      { addressBookIds: { book: true }, id: 'f', kind: 'individual', name: { full: 'Another' }, emails: { e: { address: 'another@example.com' } } },
    ];
    useContactStore.setState({ contacts });
    const { onAdd } = search('Test group', [{ name: 'Already invited', email: 'existing@example.com' }]);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Test group/ }));
    expect(onAdd.mock.calls.map(([person]) => person)).toEqual([
      { name: 'New', email: 'new@example.com' },
      { name: 'Another', email: 'another@example.com' },
    ]);
  });

  it('keeps two matching groups selectable as separate suggestions', () => {
    const contacts = createDemoContacts();
    const group = contacts.find(c => c.id === 'demo-group-beacon')!;
    useContactStore.setState({ contacts: [...contacts, { ...group, id: 'other-group', name: { full: 'Beacon other team' } }] });
    const { onAdd } = search('Beacon');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Beacon other team/ }));
    expect(onAdd).toHaveBeenCalledTimes(5);
  });

});
