import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

import { ShareSheetHost } from '@/components/share-sheet-host';
import { SHARE_NEEDS_TAP_EVENT, setDownloadGuard, type ShareNeedsTapDetail } from '@/lib/download-guard';

// When iOS wants a fresh tap before it opens the share sheet, the host offers
// the file in a toast; its Save button asks the device policy again.

afterEach(() => {
  setDownloadGuard(null);
  toast.info.mockReset();
  vi.restoreAllMocks();
});

function needsTap(detail: ShareNeedsTapDetail) {
  act(() => { window.dispatchEvent(new CustomEvent(SHARE_NEEDS_TAP_EVENT, { detail })); });
}

describe('ShareSheetHost', () => {
  it('offers the waiting file with a Save button that opens the share sheet', () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'share', { value: share, configurable: true, writable: true });
    render(<ShareSheetHost />);
    const file = new File(['PK'], 'Attachments.zip', { type: 'application/zip' });
    needsTap({ file, kind: 'attachment', subject: 'acc-2' });

    expect(toast.info).toHaveBeenCalledTimes(1);
    const [title, options] = toast.info.mock.calls[0] as [string, { message: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe('ready_to_save');
    expect(options.message).toBe('Attachments.zip');
    expect(options.action.label).toBe('save');

    options.action.onClick();
    expect(share).toHaveBeenCalledWith({ files: [file] });
  });

  it('opens nothing when the device policy forbids it by the time Save is tapped', () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'share', { value: share, configurable: true, writable: true });
    const guard = vi.fn(() => true);
    setDownloadGuard(guard);
    render(<ShareSheetHost />);
    needsTap({ file: new File(['PK'], 'a.zip'), kind: 'attachment', subject: 'acc-2' });

    guard.mockReturnValue(false);
    (toast.info.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    expect(guard).toHaveBeenLastCalledWith('attachment', 'acc-2');
    expect(share).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    const { unmount } = render(<ShareSheetHost />);
    unmount();
    needsTap({ file: new File(['PK'], 'a.zip'), kind: 'attachment' });
    expect(toast.info).not.toHaveBeenCalled();
  });
});
