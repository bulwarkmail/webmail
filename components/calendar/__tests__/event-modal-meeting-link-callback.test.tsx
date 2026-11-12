// The event form hands a plugin in the calendar-event-actions slot a callback that sets the
// meeting link (jitsi-meet calls it with a link). The plugin's frame decides what it passes, so
// the form takes an http(s) link that fits the field and ignores anything else.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';

const handed = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown> | undefined> }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => ({
  PluginIframeSlot: ({ slot, extraProps }: { slot: string; extraProps?: Record<string, unknown> }) => {
    handed.props[slot] = extraProps;
    return null;
  },
}));

import { EventModal } from '../event-modal';
import { clearSlotOffers, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';

const calendars = [
  { id: 'cal-1', name: 'Work', color: '#123456', isDefault: true, myRights: { mayWriteAll: true, mayWriteOwn: true } },
] as unknown as Calendar[];

afterEach(() => {
  cleanup();
  clearSlotOffers();
  handed.props = {};
});

function openForm() {
  offerSlots('p1', ['calendar-event-actions']);
  render(
    <EventModal
      calendars={calendars}
      defaultDate={new Date('2026-10-12T10:00:00')}
      defaultEndDate={new Date('2026-10-12T11:00:00')}
      defaultCalendarId="cal-1"
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const link = screen.getByPlaceholderText('https://meet.example.com/...') as HTMLInputElement;
  const call = (value: unknown) => act(() => {
    (handed.props['calendar-event-actions']!.setVirtualLocation as (v: unknown) => void)(value);
  });
  return { link, call };
}

describe('the meeting link a plugin sets in the event form', () => {
  it('takes a link the plugin passes as text', () => {
    const { link, call } = openForm();
    call('https://meet.jit.si/planning-123');
    expect(link.value).toBe('https://meet.jit.si/planning-123');
  });

  it('ignores an object, a number and nothing, and keeps the link it has', () => {
    const { link, call } = openForm();
    call('https://meet.jit.si/planning-123');
    call({ not: 'a link' });
    call(42);
    call(undefined);
    expect(link.value).toBe('https://meet.jit.si/planning-123');
  });

  it('ignores a link longer than the field, which cut would no longer be the link', () => {
    const { link, call } = openForm();
    call('https://meet.jit.si/planning-123');
    call(`https://meet.example/${'x'.repeat(10_000)}`);
    expect(link.value).toBe('https://meet.jit.si/planning-123');
  });

  it('answers the plugin whether it took the link', () => {
    openForm();
    const set = handedSetter();
    let answer: unknown;
    act(() => { answer = set('https://meet.jit.si/planning-123'); });
    expect(answer).toBe(true);
    act(() => { answer = set('smb://files.example/share'); });
    expect(answer).toBe(false);
  });
});

function handedSetter(): (value: unknown) => unknown {
  return handed.props['calendar-event-actions']!.setVirtualLocation as (value: unknown) => unknown;
}
