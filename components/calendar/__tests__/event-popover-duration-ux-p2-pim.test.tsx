import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';
import { AUTO_TIME_ZONE } from '@/lib/timezone';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// pim-p2-19: the German popover read "16:00 – 17:00 (1h)"; German writes "1 Std.".

const lang = vi.hoisted(() => ({ locale: 'de' }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => lang.locale,
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));

import { EventDetailPopover } from '../event-detail-popover';

const calendar = { id: 'cal', name: 'Work', myRights: { mayWriteAll: true, mayWriteOwn: true } } as unknown as Calendar;

function popover(duration: string) {
  const event = {
    id: 'e1', calendarIds: { cal: true }, title: 'Team sync', start: '2026-11-05T16:00:00', duration,
    timeZone: 'Europe/Berlin', showWithoutTime: false, participants: null, alerts: null, useDefaultAlerts: false,
  } as unknown as CalendarEvent;
  render(
    <EventDetailPopover event={event} calendar={calendar} anchorRect={new DOMRect(100, 100, 50, 20)}
      onEdit={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} onSaveNote={vi.fn()}
      currentUserEmails={['me@example.com']} />,
  );
}

beforeEach(() => useSettingsStore.setState({ timeZone: 'Europe/Berlin' }));
afterEach(() => {
  useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE });
  lang.locale = 'de';
});

describe('the popover writes the duration in the app language', () => {
  it('in German', () => {
    popover('PT1H');
    expect(screen.getByText('(1 Std.)')).toBeInTheDocument();
    expect(screen.queryByText('(1h)')).toBeNull();
  });

  it('with hours and minutes', () => {
    popover('PT1H30M');
    expect(screen.getByText('(1 Std. 30 Min.)')).toBeInTheDocument();
  });

  it('in English', () => {
    lang.locale = 'en';
    popover('PT45M');
    expect(screen.getByText('(45 min)')).toBeInTheDocument();
  });
});
