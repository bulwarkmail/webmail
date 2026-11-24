import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventModal } from '../event-modal';
import { EventDetailPopover } from '../event-detail-popover';
import { useAuthStore } from '@/stores/auth-store';
import type { Calendar, CalendarEvent, CalendarLink } from '@/lib/jmap/types';

// #1597: files attached to an event are shown, downloaded through the
// authenticated blob download, added (where the server keeps them) and
// removed; links other clients wrote stay as they were.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));

const calendars = [
  { id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true, mayWriteOwn: true } },
] as unknown as Calendar[];

const agenda = { '@type': 'Link', rel: 'describedby', href: 'https://example.org/agenda' } as CalendarLink;
const notes = { '@type': 'Link', rel: 'enclosure', blobId: 'blob-1', title: 'notes.txt', contentType: 'text/plain', size: 16 } as CalendarLink;
const plan = { '@type': 'Link', rel: 'enclosure', href: 'https://files.example.org/plan.pdf', title: 'plan.pdf' } as CalendarLink;

function makeEvent(extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1', '@type': 'Event', uid: 'uid-1', calendarIds: { 'cal-1': true }, title: 'Site visit', description: '',
    start: '2026-11-20T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    participants: null, recurrenceRules: null, virtualLocations: null, locations: null, alerts: null, useDefaultAlerts: false,
    links: { x: agenda, a: notes, b: plan },
    ...extra,
  } as unknown as CalendarEvent;
}

function useClient(blobLinks: boolean) {
  const client = {
    getCalendarsAccountId: () => 'account-1',
    supportsCalendarBlobLinks: vi.fn(() => blobLinks),
    getMaxSizeUpload: () => 1000,
    downloadBlob: vi.fn().mockResolvedValue(undefined),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: 'blob-new', size: file.size, type: file.type })),
    hasAccountCapability: () => false,
    getAccountOwners: async () => ({}),
  };
  useAuthStore.setState({ client } as never);
  return client;
}

async function savedData(onSave: ReturnType<typeof vi.fn>): Promise<Partial<CalendarEvent>> {
  fireEvent.click(screen.getByText('form.save'));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  return onSave.mock.calls[0][0];
}

afterEach(() => useAuthStore.setState({ client: null } as never));

describe('event attachments in the detail popover', () => {
  function renderPopover(event: CalendarEvent) {
    render(
      <EventDetailPopover event={event} calendar={calendars[0]} anchorRect={new DOMRect(100, 100, 50, 20)}
        onEdit={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} onClose={vi.fn()} onSaveNote={vi.fn()} />,
    );
  }

  it('downloads a stored file from the calendars account and opens a file address', async () => {
    const client = useClient(true);
    renderPopover(makeEvent());
    fireEvent.click(screen.getByText('notes.txt'));
    await waitFor(() => expect(client.downloadBlob).toHaveBeenCalledWith('blob-1', 'notes.txt', 'text/plain', 'account-1'));
    expect(screen.getByText('plan.pdf').closest('a')?.getAttribute('href')).toBe('https://files.example.org/plan.pdf');
    expect(screen.queryByText('https://example.org/agenda')).toBeNull();
  });

  it("downloads a shared event's file from the owner's account", async () => {
    const client = useClient(true);
    renderPopover(makeEvent({ isShared: true, accountId: 'owner-account' }));
    fireEvent.click(screen.getByText('notes.txt'));
    await waitFor(() => expect(client.downloadBlob).toHaveBeenCalledWith('blob-1', 'notes.txt', 'text/plain', 'owner-account'));
  });
});

describe('event attachments in the editor', () => {
  it('offers adding a file only where the server keeps blob links', () => {
    useClient(false);
    const { unmount } = render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.queryByText('attachments.add')).toBeNull();
    unmount();

    useClient(true);
    render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('attachments.add')).toBeTruthy();
  });

  it('leaves the links out of a save that did not touch the files', async () => {
    useClient(true);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('form.title'), { target: { value: 'Site visit 2' } });
    const data = await savedData(onSave);
    expect('links' in data).toBe(false);
  });

  it('removes a file and keeps the links other clients wrote', async () => {
    useClient(false);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByLabelText('remove')[0]);
    expect(screen.queryByText('notes.txt')).toBeNull();
    const data = await savedData(onSave);
    expect(data.links).toEqual({ x: agenda, b: plan });
  });

  it('uploads a picked file into the event account on save and adds its link', async () => {
    const client = useClient(true);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    const file = new File(['%PDF-1.7'], 'offer.pdf', { type: 'application/pdf' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(screen.getByText('offer.pdf')).toBeTruthy();
    expect(client.uploadBlob).not.toHaveBeenCalled();

    const data = await savedData(onSave);
    expect(client.uploadBlob).toHaveBeenCalledWith(file, { accountId: 'account-1', noHold: true });
    const links = data.links!;
    expect(links.x).toEqual(agenda);
    expect(links.a).toEqual(notes);
    expect(links.b).toEqual(plan);
    const added = Object.entries(links).filter(([k]) => !['x', 'a', 'b'].includes(k));
    expect(added.map(([, l]) => l)).toEqual([
      { '@type': 'Link', blobId: 'blob-new', rel: 'enclosure', contentType: 'application/pdf', size: 8, title: 'offer.pdf' },
    ]);
  });

  it('does not save when the upload fails', async () => {
    const client = useClient(true);
    client.uploadBlob.mockRejectedValueOnce(new Error('413'));
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.txt')] } });
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(client.uploadBlob).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses a file larger than the server takes', () => {
    const client = useClient(true);
    const { container } = render(<EventModal event={makeEvent()} startInEditMode calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'.repeat(2000)], 'big.bin')] } });
    expect(screen.queryByText('big.bin')).toBeNull();
    expect(client.uploadBlob).not.toHaveBeenCalled();
  });
});
