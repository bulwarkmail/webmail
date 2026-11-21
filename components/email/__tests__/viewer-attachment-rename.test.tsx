import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Renaming an attachment in the reader: the copy the user saves gets the
// name they typed, without the download template. Nothing is written back,
// and another message, or this one opened again, has the original names.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const makeEmail = (id: string) => ({
  id,
  blobId: `b-${id}`,
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  subject: 'Invoice',
  receivedAt: '2026-01-01T00:00:00Z',
  preview: 'See attached',
  hasAttachment: true,
  size: 100,
  textBody: [],
  htmlBody: [],
  attachments: [{ partId: '2', blobId: 'blob-pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, disposition: 'attachment' }],
  bodyValues: {},
}) as unknown as Email;

const client = new Proxy({ getAccountId: () => 'me' } as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : vi.fn().mockResolvedValue(null)),
}) as unknown as IJMAPClient;

const download = () => fireEvent.click(screen.getAllByRole('button', { name: 'download_named' })[0]);

async function rename(stem: string) {
  fireEvent.click(screen.getAllByRole('button', { name: 'rename_named' })[0]);
  const input = await screen.findByRole('textbox', { name: 'rename_title' }) as HTMLInputElement;
  // The extension is not in the field: it stays.
  expect(input.value).toBe('invoice');
  expect(screen.getByTestId('prompt-suffix')).toHaveTextContent('.pdf');
  fireEvent.change(input, { target: { value: stem } });
  fireEvent.click(screen.getByRole('button', { name: 'rename' }));
}

describe('renaming an attachment in the reader', () => {
  let template: unknown;

  beforeEach(() => {
    useAuthStore.setState({ client } as never);
    template = useSettingsStore.getState().attachmentDownloadTemplate;
    useSettingsStore.setState({ attachmentDownloadTemplate: '{subject} - {filename}' } as never);
  });
  afterEach(() => {
    useSettingsStore.setState({ attachmentDownloadTemplate: template } as never);
  });

  it('downloads under the new name, without the template', async () => {
    const onDownloadAttachment = vi.fn();
    render(<EmailViewer email={makeEmail('e1')} mailboxes={[]} selectedMailbox="inbox" onDownloadAttachment={onDownloadAttachment} />);

    // The template applies until the user picks a name.
    download();
    expect(onDownloadAttachment).toHaveBeenLastCalledWith('blob-pdf', 'Invoice - invoice.pdf', 'application/pdf', true);

    await rename('Q3 invoice, paid');
    await waitFor(() => expect(screen.getAllByTestId('attachment')[0]).toHaveAttribute('data-attachment-name', 'Q3 invoice, paid.pdf'));
    download();
    expect(onDownloadAttachment).toHaveBeenLastCalledWith('blob-pdf', 'Q3 invoice, paid.pdf', 'application/pdf', true);
  });

  it('shows the original names again for another message and when this one comes back', async () => {
    const onDownloadAttachment = vi.fn();
    const { rerender } = render(<EmailViewer email={makeEmail('e1')} mailboxes={[]} selectedMailbox="inbox" onDownloadAttachment={onDownloadAttachment} />);
    await rename('renamed');
    await waitFor(() => expect(screen.getAllByTestId('attachment')[0]).toHaveAttribute('data-attachment-name', 'renamed.pdf'));

    // The same blob in another message: not renamed there.
    await act(async () => {
      rerender(<EmailViewer email={makeEmail('e2')} mailboxes={[]} selectedMailbox="inbox" onDownloadAttachment={onDownloadAttachment} />);
    });
    expect(screen.getAllByTestId('attachment')[0]).toHaveAttribute('data-attachment-name', 'invoice.pdf');

    await act(async () => {
      rerender(<EmailViewer email={makeEmail('e1')} mailboxes={[]} selectedMailbox="inbox" onDownloadAttachment={onDownloadAttachment} />);
    });
    expect(screen.getAllByTestId('attachment')[0]).toHaveAttribute('data-attachment-name', 'invoice.pdf');
    download();
    expect(onDownloadAttachment).toHaveBeenLastCalledWith('blob-pdf', 'Invoice - invoice.pdf', 'application/pdf', true);
  });
});
