import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { useSettingsStore } from '@/stores/settings-store';
import type { Calendar } from '@/lib/jmap/types';

// #1318: a new event lasts as long as Settings > Calendar says, not always an hour.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
vi.mock('../participant-availability', () => ({ ParticipantAvailability: () => null }));

const RIGHTS = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
};
const calendars = [{ id: 'cal', name: 'Work', color: '#123456', isDefault: true, myRights: RIGHTS }] as unknown as Calendar[];
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => useSettingsStore.setState({ defaultEventLength: 60, timeFormat: '24h' }));

describe('a new event in the editor', () => {
  it('ends after the default length', () => {
    useSettingsStore.setState({ defaultEventLength: 30, timeFormat: '24h' });
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} defaultDate={new Date(2026, 8, 3, 9, 0)} defaultEndDate={undefined} />);
    const start = field('form.start_time').value;
    const [h, m] = start.split(':').map(Number);
    const end = new Date(2026, 8, 3, h, m + 30);
    expect(field('form.end_time').value).toBe(`${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`);
  });
});
