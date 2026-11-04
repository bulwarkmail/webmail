import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
const saveBlobAs = vi.fn(() => true);
vi.mock('@/lib/download-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/download-guard')>()),
  saveBlobAs: (...args: unknown[]) => saveBlobAs(...(args as [])),
}));

import { FilePreviewModal } from '../file-preview-modal';
import { EmlPreview } from '../eml-preview';
import { useSettingsStore } from '@/stores/settings-store';

// An attached message without a file name opened as "attachment", saved as
// "attachment", in a monospace font with a 12-hour date and seconds.

const EML = [
  'From: Tobias Brenner <tobias.brenner@example.net>',
  'To: Mara Lindqvist <mara.lindqvist@example.net>',
  'Subject: Original: room booking',
  'Date: Thu, 15 Oct 2026 05:40:37 +0200',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Room 2.14 is booked.',
  '',
].join('\r\n');

const preview = (name: string, onDownload = vi.fn()) => {
  render(
    <FilePreviewModal
      name={name}
      onClose={() => {}}
      onDownload={onDownload}
      getFileContent={async () => ({ blob: new Blob([EML], { type: 'message/rfc822' }), contentType: 'message/rfc822' })}
    />,
  );
  return onDownload;
};

afterEach(() => {
  saveBlobAs.mockClear();
  useSettingsStore.setState({ timeFormat: '24h' });
});

describe('attached message preview', () => {
  it('is titled and saved by its subject when the part has no name', async () => {
    const onDownload = preview('attachment');
    await waitFor(() => expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Original: room booking'));
    fireEvent.click(screen.getByRole('button', { name: 'download' }));
    expect(onDownload).not.toHaveBeenCalled();
    expect(saveBlobAs).toHaveBeenCalledTimes(1);
    expect((saveBlobAs.mock.calls[0] as unknown[])[1]).toMatch(/^Original.*room booking\.eml$/);
  });

  it("keeps the sender's own file name", async () => {
    const onDownload = preview('booking-thread.eml');
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Original: room booking'));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('booking-thread.eml');
    fireEvent.click(screen.getByRole('button', { name: 'download' }));
    expect(onDownload).toHaveBeenCalled();
    expect(saveBlobAs).not.toHaveBeenCalled();
  });

  it("shows the body in the reader's font and the date as the reader does", () => {
    useSettingsStore.setState({ timeFormat: '24h' });
    const { container } = render(
      <EmlPreview message={{ subject: 's', text: 'Room 2.14 is booked.', date: '2026-10-15T03:40:37Z', attachments: [] }} />,
    );
    const doc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(doc).not.toContain('monospace');
    expect(doc).toContain('-apple-system');
    expect(container.textContent).not.toContain(':37');
    expect(container.textContent).not.toMatch(/AM|PM/);
  });
});
