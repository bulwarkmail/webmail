import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// p2-3: global search's results and previews call Stalwart's default calendar
// and address book "Calendar" and "Contacts", as the rest of the app does.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { PaletteResultRow } from '../palette-result-row';
import { SearchPreview } from '../search-preview';
import type { CalendarHit, ContactHit } from '@/lib/global-search/types';

const calendarHit: CalendarHit = {
  kind: 'calendar', localAccountId: 'a', jmapAccountId: 'a', id: 'e1', accountLabel: '', title: 'Standup',
  subtitle: 'Stalwart Calendar (dso-ux-pim@example.org) · Room 4', date: null, source: 'local', isRecurring: false,
  collection: { kind: 'calendar', name: 'Stalwart Calendar (dso-ux-pim@example.org)', rest: 'Room 4' },
  event: { id: 'e1', title: 'Standup', calendarIds: { c1: true } } as unknown as CalendarHit['event'],
};

const contactHit: ContactHit = {
  kind: 'contacts', localAccountId: 'a', jmapAccountId: 'a', id: 'c1', accountLabel: '', title: 'Alice',
  subtitle: 'Stalwart Address Book (dso-ux-pim@example.org) · alice@example.org', date: null, source: 'local', storeId: 'c1',
  collection: { kind: 'addressBook', name: 'Stalwart Address Book (dso-ux-pim@example.org)', rest: 'alice@example.org' },
  contact: { id: 'c1', name: { full: 'Alice' } } as unknown as ContactHit['contact'],
};

describe('global search with the server default names', () => {
  it('a calendar hit says Calendar', () => {
    const { container } = render(<PaletteResultRow hit={calendarHit} onOpen={vi.fn()} />);
    expect(container.textContent).not.toContain('Stalwart Calendar');
    expect(container.textContent).toContain('default_calendar · Room 4');
  });

  it('a contact hit says Contacts', () => {
    const { container } = render(<PaletteResultRow hit={contactHit} onOpen={vi.fn()} />);
    expect(container.textContent).not.toContain('Stalwart Address Book');
    expect(container.textContent).toContain('default_address_book · alice@example.org');
  });

  it('the previews say the same', () => {
    const { container } = render(<><SearchPreview hit={calendarHit} onOpen={vi.fn()} onClose={vi.fn()} /><SearchPreview hit={contactHit} onOpen={vi.fn()} onClose={vi.fn()} /></>);
    expect(container.textContent).not.toMatch(/Stalwart (Calendar|Address Book)/);
  });
});
