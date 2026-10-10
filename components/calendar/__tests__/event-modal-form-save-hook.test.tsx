import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventModal } from '../event-modal';
import { calendarFormHooks, removeAllPluginHooks } from '@/lib/plugin-hooks';
import type { Calendar } from '@/lib/jmap/types';

// The form-save hook runs before the event is saved. A plugin handler can take
// a while (minting a meeting room), and the save must count as in flight for
// that whole time, or a second click creates the new event twice.

const calendars = [
  { id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true, mayWriteOwn: true } },
] as unknown as Calendar[];

afterEach(() => {
  removeAllPluginHooks('test-plugin');
});

describe('EventModal form-save hook', () => {
  it('saves once when Save is pressed again while a plugin handler is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    calendarFormHooks.onCalendarEventFormSave.register('test-plugin', async () => {
      await gate;
      return { virtualLocation: 'https://meet.example.com/room-1' };
    });
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <EventModal
        calendars={calendars}
        defaultDate={new Date('2026-10-12T10:00:00')}
        defaultCalendarId="cal-1"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Sync' } });
    const save = screen.getByText('form.save');
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });

    await act(async () => { release(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // Give a stray second save the chance to show up.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(onSave).toHaveBeenCalledTimes(1);
    const data = onSave.mock.calls[0][0];
    expect(Object.values(data.virtualLocations)[0]).toMatchObject({ uri: 'https://meet.example.com/room-1' });
  });
});
