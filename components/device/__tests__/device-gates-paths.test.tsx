import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ appName: 'Bulwark', faviconUrl: '', appLogoLightUrl: '', appLogoDarkUrl: '' }),
}));
vi.mock('@/stores/toast-store', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ startDrag: vi.fn(), endDrag: vi.fn(), isDragging: false, draggedEmails: [] }),
}));
vi.mock('@/hooks/use-attachment-drag', () => ({ isDragOutSupported: () => true }));

import { PWAInstallPrompt } from '@/components/pwa-install-prompt';
import { EmlPreview, type ParsedEml } from '@/components/files/eml-preview';
import { dispatchApiCall } from '@/lib/plugin-sandbox/host-api';
import { resetPluginRateLimits } from '@/lib/plugin-sandbox/host-api-input';
import { memorySink } from '@/lib/mail-export/sinks';
import { useEmailDrag } from '@/hooks/use-email-drag';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import type { InstalledPlugin } from '@/lib/plugin-types';
import type { Email } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useMailTransferStore } from '@/stores/mail-transfer-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useUIStore } from '@/stores/ui-store';

// The other paths of the device policies (Organisation > Devices): the
// plugin APIs, .eml previews, dragging messages out, the export file, and
// the install prompt after the user dismissed Bulwark's own card.

function setDevices(devices: Record<string, boolean>) {
  const policy = { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null, loaded: true });
}

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();
let click: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  resetPluginRateLimits();
  useAuthStore.setState({ activeAccountId: 'acc-a', username: 'alice@example.org', getAllConnectedClients: (() => new Map()) as never });
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
  useMailTransferStore.setState({ job: null, request: null, visible: false });
  vi.restoreAllMocks();
});

const PLUGIN: InstalledPlugin = {
  id: 'p', name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
  permissions: ['ui:download-file'], grantedPermissions: ['ui:download-file'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
};

describe('plugins', () => {
  it('can’t save a file under "No downloads" or "No export"', async () => {
    setDevices({ noDownloads: true });
    await expect(dispatchApiCall(PLUGIN, 'ui.downloadFile', [{ content: 'x', filename: 'a.txt', contentType: 'text/plain' }])).rejects.toThrow(/turned off by the organisation/);
    setDevices({ noExport: true });
    await expect(dispatchApiCall(PLUGIN, 'ui.downloadFile', [{ content: 'x', filename: 'a.txt', contentType: 'text/plain' }])).rejects.toThrow(/turned off by the organisation/);
    expect(click).not.toHaveBeenCalled();
    setDevices({});
    await dispatchApiCall(PLUGIN, 'ui.downloadFile', [{ content: 'x', filename: 'a.txt', contentType: 'text/plain' }]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('can’t print under "No printing"', async () => {
    setDevices({ noPrint: true });
    await expect(dispatchApiCall(PLUGIN, 'ui.print', [{ html: '<p>x</p>' }])).rejects.toThrow(/printing is turned off/);
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('.eml previews', () => {
  const eml: ParsedEml = {
    subject: 'Fwd', from: null, to: [], date: null, text: 'see attached', html: null,
    attachments: [
      { filename: 'data.zip', mimeType: 'application/zip', content: new Uint8Array([1]) },
      { filename: 'chart.png', mimeType: 'image/png', content: new Uint8Array([1]) },
    ],
  } as unknown as ParsedEml;

  it('offer no download of their attachments under "No downloads"', () => {
    render(<EmlPreview message={eml} onOpenAttachment={() => {}} downloadsOff />);
    expect(screen.queryByTitle('download')).toBeNull();
    fireEvent.click(screen.getByText('data.zip'));
    expect(click).not.toHaveBeenCalled();
  });
});

describe('dragging messages out', () => {
  it('fetches nothing to drag out under "No export"; moving between folders still drags', () => {
    setDevices({ noExport: true });
    const fetchBlobAsObjectUrl = vi.fn(async () => 'blob:eml');
    useAuthStore.setState({ client: { fetchBlobAsObjectUrl, getAccountId: () => 'a' } as never });
    useUIStore.setState({ isMobile: false });
    const email = { id: 'e', blobId: 'b', threadId: 't', subject: 'S', receivedAt: '2026-11-01T00:00:00Z', mailboxIds: {}, keywords: {} } as unknown as Email;
    const { result } = renderHook(() => useEmailDrag({ email, sourceMailboxId: 'inbox' }));
    expect(result.current.dragHandlers.draggable).toBe(true);
    act(() => { (result.current.dragHandlers as { onPointerEnter?: () => void }).onPointerEnter?.(); });
    expect(fetchBlobAsObjectUrl).not.toHaveBeenCalled();
  });
});

describe('the export file', () => {
  it('isn’t handed out once "No export" is on', async () => {
    setDevices({ noExport: true });
    const sink = memorySink('all.mbox', 'application/mbox');
    await sink.write(new Uint8Array([70, 114, 111, 109]));
    await sink.close();
    expect(click).not.toHaveBeenCalled();
  });
});

describe('install prompt', () => {
  it('holds back the browser’s banner under the policy even after the user dismissed Bulwark’s card', () => {
    localStorage.setItem('pwa-install-dismissed', '1');
    setDevices({ noInstallPrompt: true });
    render(<PWAInstallPrompt />);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });
});
