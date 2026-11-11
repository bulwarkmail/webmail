import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A formatter that applies the options, as next-intl does, in English: the
// language whose own default is the 12-hour clock.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(d),
  }),
}));

import { ContactActivity } from '../contact-activity';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { CalendarEvent, ContactCard } from '@/lib/jmap/types';

const contact: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { full: 'Alice Johnson' },
  emails: { e0: { address: 'alice@example.com' } },
};

const event = {
  id: 'ev1',
  title: 'Planning',
  start: '2026-01-15T16:00:00',
  showWithoutTime: false,
  participants: { p1: { email: 'alice@example.com' } },
} as unknown as CalendarEvent;

describe('contact upcoming events (#1616)', () => {
  beforeEach(() => {
    useAuthStore.setState({
      client: {
        advancedSearchEmails: vi.fn(async () => ({ emails: [] })),
        queryAllCalendarEvents: vi.fn(async () => [event]),
      } as never,
    });
  });

  afterEach(() => {
    useAuthStore.setState({ client: null });
    useSettingsStore.setState({ timeFormat: '24h' });
  });

  it('shows the time on the 24-hour clock when that is the setting, whatever the language', async () => {
    useSettingsStore.setState({ timeFormat: '24h' });
    render(<ContactActivity contact={contact} />);
    expect(await screen.findByText('16:00')).toBeInTheDocument();
  });

  it('shows the time on the 12-hour clock when that is the setting', async () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    render(<ContactActivity contact={contact} />);
    expect(await screen.findByText('4:00 PM')).toBeInTheDocument();
  });
});
