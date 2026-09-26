import { render, renderHook, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useWopiStatus } from '@/hooks/use-wopi-status';
import { WopiEditor } from '@/components/files/wopi-editor';

// Behind a reverse proxy at a sub-path (e.g. /webmail) a bare
// fetch('/api/...') reaches the mail server instead of the webmail and comes
// back 404, which left office editing permanently "unavailable" there. Both
// WOPI requests have to carry the mount prefix.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.pushState({}, '', '/webmail/de/mail');
  fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('WOPI requests under a sub-path mount', () => {
  it('probes the editor status under the mount prefix', async () => {
    renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/webmail/api/wopi/status');
  });

  it('launches the editor under the mount prefix', async () => {
    render(<WopiEditor target={{ kind: 'file', id: 'f1', name: 'report.docx' }} onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/webmail/api/wopi/launch');
  });
});
