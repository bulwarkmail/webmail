import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfflineStore } from '@/lib/offline/state';
import { ICalImportModal } from '../ical-import-modal';

// A .ics opened from the OS. The server reads it, so without a connection the
// dialog has to say so instead of calling a good file invalid.

vi.mock('@/stores/calendar-store', () => ({
  useCalendarStore: (selector: (state: { importEvents: () => Promise<number> }) => unknown) => selector({ importEvents: async () => 1 }),
}));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const calendars = [{ id: 'cal-1', name: 'Home', isDefault: true }] as never[];
const ics = () => new File(['BEGIN:VCALENDAR'], 'invite.ics', { type: 'text/calendar' });

function client(overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => 'https://mail.example.org',
    getCalendarsAccountId: () => 'acc',
    uploadBlob: vi.fn(async () => ({ blobId: 'blob-1' })),
    parseCalendarEvents: vi.fn(async () => [{ title: 'Standup', start: '2026-11-03T09:00:00' }]),
    ...overrides,
  } as never as { uploadBlob: ReturnType<typeof vi.fn>; parseCalendarEvents: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  useOfflineStore.setState({ browserOffline: false, downServers: [] });
});

afterEach(() => {
  useOfflineStore.setState({ browserOffline: false, downServers: [] });
});

describe('ICalImportModal with an initial file', () => {
  it('reads the file at once and shows the preview', async () => {
    const c = client();
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} initialFile={ics()} />);
    await screen.findByText('Standup');
    expect(c.uploadBlob).toHaveBeenCalledTimes(1);
    expect(c.parseCalendarEvents).toHaveBeenCalledWith('acc', 'blob-1');
  });

  it('reads nothing without one', async () => {
    const c = client();
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} />);
    await act(async () => {});
    expect(c.uploadBlob).not.toHaveBeenCalled();
  });

  it('says the server is needed when offline, and starts by itself once back online', async () => {
    useOfflineStore.setState({ browserOffline: true });
    const c = client();
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} initialFile={ics()} />);
    expect(await screen.findByText('ics_needs_server')).toBeInTheDocument();
    expect(c.uploadBlob).not.toHaveBeenCalled();

    useOfflineStore.setState({ browserOffline: false });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await screen.findByText('Standup');
    expect(c.uploadBlob).toHaveBeenCalledTimes(1);
  });

  it('says the same when the connection fails while it reads', async () => {
    const c = client({
      uploadBlob: vi.fn(async () => {
        useOfflineStore.setState({ downServers: ['https://mail.example.org'] });
        throw new TypeError('Failed to fetch');
      }),
    });
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} initialFile={ics()} />);
    expect(await screen.findByText('ics_needs_server')).toBeInTheDocument();
  });

  it('still calls a bad file invalid while online', async () => {
    const c = client({ parseCalendarEvents: vi.fn(async () => { throw new Error('parse'); }) });
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} initialFile={ics()} />);
    expect(await screen.findByText('invalid_format')).toBeInTheDocument();
  });

  it('applies the size limit to it', async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.ics');
    const c = client();
    render(<ICalImportModal calendars={calendars} client={c as never} onClose={vi.fn()} initialFile={big} />);
    expect(await screen.findByText('file_too_large')).toBeInTheDocument();
    expect(c.uploadBlob).not.toHaveBeenCalled();
  });

  it('picks the default calendar when the calendars load after it opened', async () => {
    const importEvents = vi.fn();
    const c = client();
    const view = render(<ICalImportModal calendars={[]} client={c as never} onClose={vi.fn()} initialFile={ics()} />);
    await screen.findByText('Standup');
    view.rerender(
      <ICalImportModal
        calendars={[{ id: 'a', name: 'Work' }, { id: 'b', name: 'Home', isDefault: true }] as never[]}
        client={c as never}
        onClose={vi.fn()}
        initialFile={ics()}
      />,
    );
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('b'));
    expect(importEvents).not.toHaveBeenCalled();
  });
});
