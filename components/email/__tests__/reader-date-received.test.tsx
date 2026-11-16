import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { formatDateTime } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import { buildMessagePrintFields } from '../message-print-fields';

// #1699: the list showed when a mail arrived and the reader when it was
// written, so a mail held up on the way had two dates. The reader and a
// printout show the arrival, as the list does; the sender's Date header is
// in the details.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

// Written on the 1st, held up, delivered on the 3rd.
const SENT = '2026-11-01T12:00:00Z';
const RECEIVED = '2026-11-03T12:00:00Z';
const email = {
  id: 'e1', blobId: 'b-e1', threadId: 't-e1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Sam', email: 'sam@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Held up', sentAt: SENT, receivedAt: RECEIVED, preview: 'Hello',
  hasAttachment: false, size: 100, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

const headerDate = (iso: string) =>
  formatDateTime(iso, useSettingsStore.getState().timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

describe('the date the reader shows (#1699)', () => {
  it('is when the mail arrived, with the sent date in the details', () => {
    render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" isLoading={false} />);
    expect(document.body.textContent).toContain(headerDate(RECEIVED));
    expect(document.body.textContent).not.toContain(headerDate(SENT));

    act(() => { fireEvent.click(screen.getAllByText('show_details')[0]); });
    expect(document.querySelector(`time[datetime="${SENT}"]`)).not.toBeNull();
  });

  it('is when the mail arrived on a printout', () => {
    const fields = buildMessagePrintFields({
      email, html: '', isHtml: false, attachments: [], timeFormat: '24h', noSubject: '', unknownSender: '',
    });
    expect(fields.date).toBe(formatDateTime(RECEIVED, '24h', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }));
  });
});
