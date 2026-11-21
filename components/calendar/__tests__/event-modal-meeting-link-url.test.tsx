// The meeting link a calendar plugin sets goes into the event's virtual location: the event
// popover offers it as a link, "Copy meeting link" copies it, the downloaded .ics holds it and the
// invitation the user's own address sends carries it to every attendee. So the callback takes a
// web link only (http or https, one line, at most the field's length) and ignores anything else;
// jitsi-meet 1.3.1 passes https://meet.jit.si/... .
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

describe('the meeting link a plugin may set', () => {
  it.each([
    ['a script link', 'javascript:alert(document.cookie)'],
    ['a data link', 'data:text/html,<script>alert(1)</script>'],
    ['a file share', 'smb://attacker.example/share/meeting'],
    ['an app scheme that starts a program', 'ms-msdt:/id PCWDiagnostic /skip force'],
    ['a search scheme', 'search-ms:query=invoice&crumb=location:\\\\attacker.example\\share'],
    ['a link with a line break and an iCalendar line after it', 'https://meet.jit.si/a\r\nATTENDEE:mailto:someone@example.org'],
    ['plain words', 'Call me on 0000 000 000'],
  ])('ignores %s', (_, value) => {
    const { link, call } = openForm();
    call('https://meet.jit.si/planning-123');
    call(value);
    expect(link.value).toBe('https://meet.jit.si/planning-123');
  });

  // Controls.
  it.each(['https://meet.jit.si/planning-123', 'http://meet.example.org/room?pwd=1'])('takes %s', (value) => {
    const { link, call } = openForm();
    call(value);
    expect(link.value).toBe(value);
  });
});
