import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailExport, useSaveEmails } from '@/hooks/use-message-file-actions';
import { setDownloadGuard } from '@/lib/download-guard';
import type { Email } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { toast } from '@/stores/toast-store';

// Save as… (the File menu and the message's ⋮): the desktop app's own Save dialog, a
// download in a browser, and "After export" for one message only.

const client = {
  fetchBlob: vi.fn(async (blobId: string) => new Blob([`raw ${blobId}`])),
  downloadBlob: vi.fn(async () => {}),
};
const mail = (id: string, subject: string) => ({ id, blobId: `blob-${id}`, subject, receivedAt: '2026-11-01T10:00:00Z', from: [{ email: 'a@example.org' }] }) as unknown as Email;

function fakeShell(begin: unknown = { id: 's1' }) {
  const written: { index: number; text: string }[] = [];
  const saveAs = {
    begin: vi.fn(async () => begin),
    write: vi.fn(async (_id: string, index: number, data: Uint8Array) => {
      written.push({ index, text: new TextDecoder().decode(data) });
      return true;
    }),
    end: vi.fn(async () => ({ saved: written.length, failed: 0 })),
  };
  window.bulwarkDesktop = { version: 1, platform: 'win32', saveAs } as never;
  return { saveAs, written };
}

const initial = { auth: useAuthStore.getState(), settings: useSettingsStore.getState() };
beforeEach(() => {
  client.fetchBlob.mockClear();
  client.downloadBlob.mockClear();
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
  useSettingsStore.setState({ postExportAction: 'trash' });
});
afterEach(() => {
  delete window.bulwarkDesktop;
  setDownloadGuard(null);
  useAuthStore.setState(initial.auth, true);
  useSettingsStore.setState(initial.settings, true);
  vi.restoreAllMocks();
});

describe('saving messages', () => {
  it('saves several through the desktop app\'s dialog, each its own .eml, with no download and no "After export"', async () => {
    const { saveAs, written } = fakeShell();
    const success = vi.spyOn(toast, 'success');
    const onDelete = vi.fn();
    const { result } = renderHook(() => useSaveEmails());
    await act(() => result.current([mail('m1', 'First'), mail('m2', 'Second')], { onDelete }));
    const names = (saveAs.begin.mock.calls[0] as unknown as [{ names: string[]; kind: string }])[0];
    expect(names.kind).toBe('message');
    expect(names.names).toHaveLength(2);
    expect(names.names.every((name) => name.endsWith('.eml'))).toBe(true);
    expect(written).toEqual([{ index: 0, text: 'raw blob-m1' }, { index: 1, text: 'raw blob-m2' }]);
    expect(client.downloadBlob).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('saved_many');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('keeps "After export" for one message, as the ⋮ menu\'s Export did, and not when the dialog was cancelled', async () => {
    fakeShell();
    const onDelete = vi.fn();
    const { result } = renderHook(() => useEmailExport());
    await act(() => result.current(mail('m1', 'Only'), { onDelete }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    fakeShell({ cancelled: true });
    await act(() => result.current(mail('m1', 'Only'), { onDelete }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(client.fetchBlob).toHaveBeenCalledTimes(1);
  });

  it('is a download in a browser', async () => {
    const { result } = renderHook(() => useEmailExport());
    await act(() => result.current(mail('m1', 'Only')));
    expect(client.downloadBlob).toHaveBeenCalledTimes(1);
    expect(client.downloadBlob.mock.calls[0]).toEqual(expect.arrayContaining(['blob-m1', 'message/rfc822']));
  });

  it('saves nothing when the device policy forbids exporting one of them', async () => {
    const { saveAs } = fakeShell();
    setDownloadGuard((kind, subject) => !(kind === 'export' && (subject as Email)?.id === 'm2'));
    const { result } = renderHook(() => useSaveEmails());
    await act(() => result.current([mail('m1', 'First'), mail('m2', 'Second')]));
    expect(saveAs.begin).not.toHaveBeenCalled();
    expect(client.fetchBlob).not.toHaveBeenCalled();
  });
});
