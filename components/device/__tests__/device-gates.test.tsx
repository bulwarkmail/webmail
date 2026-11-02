import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ appName: 'Bulwark', faviconUrl: '', appLogoLightUrl: '', appLogoDarkUrl: '' }),
}));
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

import { PWAInstallPrompt } from '@/components/pwa-install-prompt';
import { ReaderAttachments, type ReaderAttachmentItem } from '@/components/email/reader-attachments';
import { DevicePolicyHost, NO_PRINT_ATTRIBUTE } from '@/components/device/device-policy-host';
import { FilePreviewModal } from '@/components/files/file-preview-modal';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from '@/lib/admin/organisation-policy';
import { saveBlobAs } from '@/lib/download-guard';
import { printDocument } from '@/lib/plugin-sandbox/host-api-print';
import { usePolicyStore } from '@/stores/policy-store';
import { useMailTransferStore, openMailExport, openMailImport } from '@/stores/mail-transfer-store';
import { requestPrint, usePrintStore } from '@/stores/print-store';
import { useAuthStore } from '@/stores/auth-store';

// The device policies through the components that hold them
// (Organisation > Devices). One account is signed in here, so its policy
// is also the strictest.

type Devices = OrganisationPolicy['devices'];
function setDevices(devices: Partial<Devices>) {
  const policy = { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null, loaded: true });
}

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();
beforeEach(() => {
  localStorage.clear();
  toast.info.mockClear();
  useAuthStore.setState({ activeAccountId: 'acc-a', username: 'alice@example.org', getAllConnectedClients: (() => new Map()) as never });
});
afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
  useMailTransferStore.setState({ request: null, visible: false, job: null });
  vi.restoreAllMocks();
});

const pdf: ReaderAttachmentItem = { id: 'p', name: 'Plan.pdf', type: 'application/pdf', size: 10, blobId: 'b1' };
const zip: ReaderAttachmentItem = { id: 'z', name: 'Data.zip', type: 'application/zip', size: 10, blobId: 'b2' };

describe('No downloads', () => {
  function bar(downloadsOff: boolean) {
    const props = {
      attachments: [pdf, zip],
      thumbUrls: {},
      opensPreview: (a: ReaderAttachmentItem) => a.id === 'p',
      onOpen: vi.fn(),
      onDownload: vi.fn(),
      onDownloadAll: vi.fn(),
      downloadingAll: false,
      downloadsOff,
    };
    render(<ReaderAttachments {...props} />);
    return props;
  }

  it('keeps the preview and drops every download button in the reader', () => {
    const props = bar(true);
    expect(screen.queryByText('download_all')).toBeNull();
    expect(screen.queryAllByLabelText(/^download_named/)).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('preview_named'));
    expect(props.onOpen).toHaveBeenCalledWith(pdf);
    // An attachment without a preview opens nothing at all.
    fireEvent.click(screen.getByLabelText('download_off_named'));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('attachments-downloads-off')).toBeTruthy();
  });

  it('shows them while the policy is off', () => {
    bar(false);
    expect(screen.getByText('download_all')).toBeTruthy();
    expect(screen.getAllByLabelText(/^download_named/).length).toBeGreaterThan(0);
  });

  it('offers neither Download nor a new tab in the file preview', async () => {
    setDevices({ noDownloads: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    render(
      <FilePreviewModal
        name="photo.png"
        onClose={() => {}}
        onDownload={() => {}}
        getFileContent={async () => ({ blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), contentType: 'image/png' })}
        policyAccount={null}
      />,
    );
    await screen.findByAltText('photo.png');
    expect(screen.queryByLabelText('download')).toBeNull();
    expect(screen.queryByLabelText('open_in_new_tab')).toBeNull();
  });

  it('tells the user why a download did nothing', () => {
    setDevices({ noDownloads: true });
    render(<DevicePolicyHost />);
    act(() => { saveBlobAs(new Blob(['x']), 'x.pdf', { kind: 'attachment', subject: null }); });
    expect(toast.info).toHaveBeenCalledWith('download_blocked');
  });
});

describe('No export', () => {
  it('doesn’t open the export dialog, and import stays', () => {
    setDevices({ noExport: true });
    openMailExport({ mailboxId: 'm1' });
    expect(useMailTransferStore.getState().visible).toBe(false);
    openMailImport();
    expect(useMailTransferStore.getState().request).toMatchObject({ kind: 'import' });
  });

  it('stops a running export and deletes its file when switched on', async () => {
    setDevices({});
    const discard = vi.fn(async () => {});
    const controller = new AbortController();
    useMailTransferStore.setState({
      request: { kind: 'export' }, visible: true,
      job: { kind: 'export', controller, finished: Promise.resolve(), progress: { phase: 'done', exported: 1, failed: 0, failures: [], total: 1, fraction: 1, file: { name: 'a.mbox', size: 1, discard } } as never },
    });
    render(<DevicePolicyHost />);
    act(() => setDevices({ noExport: true }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith(true));
    expect(controller.signal.aborted).toBe(true);
    expect(useMailTransferStore.getState().job).toBeNull();
  });
});

describe('No printing', () => {
  it('marks the page so Ctrl+P prints only the note', () => {
    setDevices({ noPrint: true });
    const { unmount } = render(<DevicePolicyHost />);
    expect(document.documentElement.hasAttribute(NO_PRINT_ATTRIBUTE)).toBe(true);
    expect(document.querySelector('[data-print-blocked]')?.textContent).toBe('print_blocked');
    act(() => setDevices({}));
    expect(document.documentElement.hasAttribute(NO_PRINT_ATTRIBUTE)).toBe(false);
    unmount();
  });

  it('opens no print dialog for calendar and contacts', async () => {
    setDevices({ noPrint: true });
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await requestPrint({ kind: 'contact-list' });
    expect(print).not.toHaveBeenCalled();
    expect(usePrintStore.getState().printing).toBe(false);
  });
});

describe('No install prompt', () => {
  it('shows no card and holds back the browser’s own banner', () => {
    setDevices({ noInstallPrompt: true });
    render(<PWAInstallPrompt />);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByText('title')).toBeNull();
  });
});

describe('Watermark', () => {
  it('lies over plugin printouts', () => {
    expect(printDocument('T', '<p>x</p>', 'ltr', 'alice@example.org · 1 Nov 2026')).toContain('alice@example.org · 1 Nov 2026</span>');
    expect(printDocument('T', '<p>x</p>', 'ltr')).not.toContain('bulwark-watermark"');
  });
});
