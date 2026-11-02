import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImagePreviewModal } from '@/components/files/image-preview-modal';
import { ReaderAttachments, type ReaderAttachmentItem } from '@/components/email/reader-attachments';
import { blockMediaSaving } from '@/lib/device-frame';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

// "No downloads" for pictures: no "Save image as" or dragging out in the
// message frames, the attachment thumbnails and the Files image preview,
// which also gets the watermark (Organisation > Devices).

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();
afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
});

function setDevices(devices: Record<string, boolean>) {
  const policy = { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null, loaded: true });
  useAuthStore.setState({ activeAccountId: 'acc-a', username: 'alice@example.org', getAllConnectedClients: (() => new Map()) as never });
}

/** Dispatches a cancelable event and says whether something refused it. */
function refused(target: Element, type: 'contextmenu' | 'dragstart'): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('pictures under "No downloads"', () => {
  it('a message frame refuses the context menu and dragging on pictures only, while the policy is on', () => {
    const doc = document.implementation.createHTMLDocument('mail');
    doc.body.innerHTML = '<p>Text</p><img src="blob:x" alt="inline">';
    let on = true;
    blockMediaSaving(doc, () => on);
    expect(refused(doc.querySelector('img')!, 'contextmenu')).toBe(true);
    expect(refused(doc.querySelector('img')!, 'dragstart')).toBe(true);
    expect(refused(doc.querySelector('p')!, 'contextmenu')).toBe(false);
    on = false;
    expect(refused(doc.querySelector('img')!, 'contextmenu')).toBe(false);
  });

  it('attachment thumbnails can’t be saved', () => {
    const png: ReaderAttachmentItem = { id: 'p', name: 'chart.png', type: 'image/png', size: 10, blobId: 'b' };
    render(<ReaderAttachments attachments={[png]} thumbUrls={{ p: 'blob:thumb' }} opensPreview={() => true} onOpen={() => {}} onDownload={() => {}} onDownloadAll={() => {}} downloadingAll={false} downloadsOff />);
    const img = document.querySelector('[data-testid="reader-attachments"] img')!;
    expect(fireEvent.contextMenu(img)).toBe(false);
  });

  it('the Files image preview refuses saving and carries the watermark', async () => {
    setDevices({ noDownloads: true, watermark: true });
    render(<ImagePreviewModal name="photo.png" onClose={() => {}} getImageUrl={async () => 'blob:photo'} />);
    const img = await screen.findByAltText('photo.png');
    expect(fireEvent.contextMenu(img)).toBe(false);
    expect(screen.getByTestId('watermark').textContent).toContain('alice@example.org');
  });

  it('leaves the Files image preview alone without the policy', async () => {
    setDevices({});
    render(<ImagePreviewModal name="photo.png" onClose={() => {}} getImageUrl={async () => 'blob:photo'} />);
    const img = await screen.findByAltText('photo.png');
    expect(fireEvent.contextMenu(img)).toBe(true);
    expect(screen.queryByTestId('watermark')).toBeNull();
  });
});
