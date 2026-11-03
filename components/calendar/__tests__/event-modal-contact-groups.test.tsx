import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { useContactStore } from '@/stores/contact-store';
import { createDemoContacts } from '@/lib/demo/fixtures/contacts';
import { createDemoCalendars } from '@/lib/demo/fixtures/calendars';

vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

beforeEach(() => useContactStore.setState({
  contacts: createDemoContacts(), contactsLoaded: true, directoryPrincipals: [], recentRecipients: [],
}));

async function saveAfterSelecting(queries: string | string[], maxParticipants?: number) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<EventModal calendars={createDemoCalendars()} onSave={onSave} onClose={vi.fn()} currentUserEmails={['nora@meridianlabs.example']} maxParticipants={maxParticipants} />);
  fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Issue 1505 synthetic reproduction' } });
  for (const query of typeof queries === 'string' ? [queries] : queries) {
    fireEvent.change(screen.getByPlaceholderText('email_placeholder'), { target: { value: query } });
    const option = await waitFor(() => within(screen.getByRole('listbox')).getAllByRole('option', { name: new RegExp(query) })[0]);
    fireEvent.mouseDown(option);
  }
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0];
}

describe('Issue #1505: actual event editor and save payload', () => {
  it('control: individual contact survives selection and reaches saved attendees', async () => {
    const [, , metadata] = await saveAfterSelecting('Alice');
    expect(metadata.attendees).toHaveLength(1);
  });

  it('selecting Beacon team includes its five members in the saved attendees', async () => {
    const [data, , metadata] = await saveAfterSelecting('Beacon team');
    expect(metadata.attendees.map((a: { email: string }) => a.email)).toEqual([
      'alice.johnson@meridianlabs.example', 'bob.chen@meridianlabs.example',
      'priya.sharma@meridianlabs.example', 'ahmed.hassan@meridianlabs.example', 'lisa.tanaka@meridianlabs.example',
    ]);
    expect(Object.values(data.participants)).toHaveLength(6);
  });

  it('keeps an existing attendee once when adding their group', async () => {
    const [, , metadata] = await saveAfterSelecting(['Alice', 'Beacon team']);
    expect(metadata.attendees).toHaveLength(5);
    expect(metadata.attendees.filter((a: { email: string }) => a.email === 'alice.johnson@meridianlabs.example')).toHaveLength(1);
  });

  it('adds two overlapping groups without losing or duplicating attendees', async () => {
    const [, , metadata] = await saveAfterSelecting(['Beacon team', 'Leadership']);
    expect(metadata.attendees).toHaveLength(7);
    expect(new Set(metadata.attendees.map((a: { email: string }) => a.email)).size).toBe(7);
  });

  it('warns when group members plus the organizer exceed the server participant limit', async () => {
    await saveAfterSelecting('Beacon team', 5);
    expect(screen.getByRole('status')).toHaveTextContent('participants.limit_warning');
  });
});
