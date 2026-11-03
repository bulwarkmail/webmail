import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches } from '@/lib/__tests__/sw-harness';

// The launchQueue consumer. It is the only one the app may have: a second
// setConsumer replaces the first. Files used to be dropped here.

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: { current: '/' },
  toastError: vi.fn(),
  savePendingMailto: vi.fn(),
  protocolOpenMode: 'active-session',
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: hoisted.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => hoisted.pathname.current,
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: hoisted.toastError, info: vi.fn(), success: vi.fn() } }));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: Object.assign(() => undefined, { getState: () => ({ protocolOpenMode: hoisted.protocolOpenMode }) }),
}));
vi.mock('@/lib/protocol-handlers/session', () => ({
  listenForMailtoRequests: () => () => {},
  notifyPendingMailto: vi.fn(),
  notifyPendingWebcal: vi.fn(),
  requestOpenMailtoInExistingClient: vi.fn(async () => false),
  savePendingMailto: hoisted.savePendingMailto,
  savePendingWebcal: vi.fn(),
}));
// The real modal has its own tests; here: does the launch reach it, and is
// its download gated by the same function.
vi.mock('@/components/files/file-preview-modal', () => ({
  FilePreviewModal: function PreviewStub({ name, onClose, onDownload, getFileContent }: {
    name: string; onClose: () => void; onDownload: () => void;
    getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
  }) {
    const [type, setType] = React.useState('');
    React.useEffect(() => { void getFileContent().then((c) => setType(c.contentType)); }, [getFileContent]);
    return (
      <div data-testid="eml-viewer" data-type={type}>
        {name}
        <button onClick={onClose}>close</button>
        <button onClick={onDownload}>save</button>
      </div>
    );
  },
}));

const { clearHandoffs, pendingHandoffs, takeHandoff } = await import('@/lib/launch-handoff');
const { setDownloadGuard } = await import('@/lib/download-guard');
const { ProtocolLaunchHandlerProvider } = await import('../protocol-launch-handler-provider');

type Consumer = (params: { targetURL?: string; files?: Array<{ kind: string; getFile: () => Promise<File> }> }) => void;

let consumer: Consumer | null = null;
const setConsumer = vi.fn((fn: Consumer) => { consumer = fn; });
const handle = (name: string, type = '') => ({ kind: 'file', getFile: async () => new File(['x'], name, { type }) });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function mount() {
  return render(<ProtocolLaunchHandlerProvider><div>app</div></ProtocolLaunchHandlerProvider>);
}

beforeEach(() => {
  consumer = null;
  setConsumer.mockClear();
  hoisted.push.mockClear();
  hoisted.toastError.mockClear();
  hoisted.savePendingMailto.mockClear();
  hoisted.pathname.current = '/';
  hoisted.protocolOpenMode = 'active-session';
  sessionStorage.clear();
  vi.stubGlobal('caches', new FakeCaches());
  window.launchQueue = { setConsumer } as never;
});

afterEach(() => {
  clearHandoffs();
  delete window.launchQueue;
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('file launches', () => {
  it('opens a .eml in the viewer without leaving the page', async () => {
    mount();
    consumer!({ targetURL: `${window.location.origin}/mail`, files: [handle('note.eml')] });
    const viewer = await screen.findByTestId('eml-viewer');
    expect(viewer).toHaveTextContent('note.eml');
    await waitFor(() => expect(viewer).toHaveAttribute('data-type', 'message/rfc822'));
    expect(hoisted.push).not.toHaveBeenCalled();
  });

  it('shows several .eml files one after the other', async () => {
    mount();
    consumer!({ files: [handle('one.eml'), handle('two.eml')] });
    expect(await screen.findByTestId('eml-viewer')).toHaveTextContent('one.eml');
    await act(async () => { screen.getByText('close').click(); });
    expect(await screen.findByTestId('eml-viewer')).toHaveTextContent('two.eml');
    await act(async () => { screen.getByText('close').click(); });
    expect(screen.queryByTestId('eml-viewer')).toBeNull();
  });

  it("saves a .eml only if the device policy allows downloads", async () => {
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    setDownloadGuard(() => false);
    mount();
    consumer!({ files: [handle('note.eml')] });
    await screen.findByTestId('eml-viewer');
    await act(async () => { screen.getByText('save').click(); });
    expect(created).not.toHaveBeenCalled();
    setDownloadGuard(null);
  });

  it('takes a .ics to the calendar with the file waiting', async () => {
    mount();
    consumer!({ targetURL: `${window.location.origin}/calendar`, files: [handle('invite.ics')] });
    await flush();
    expect(hoisted.push).toHaveBeenCalledWith('/calendar');
    expect(takeHandoff('calendar')?.files[0].name).toBe('invite.ics');
  });

  it('takes a .vcf to the contacts with the file waiting', async () => {
    mount();
    consumer!({ files: [handle('people.vcf')] });
    await flush();
    expect(hoisted.push).toHaveBeenCalledWith('/contacts');
    expect(takeHandoff('contacts')?.files[0].name).toBe('people.vcf');
  });

  it('stays when already on the right page', async () => {
    hoisted.pathname.current = '/calendar';
    mount();
    consumer!({ files: [handle('invite.ics')] });
    await flush();
    expect(hoisted.push).not.toHaveBeenCalled();
  });

  it('goes to the page in the Pro shell too, which has one route', async () => {
    hoisted.pathname.current = '/pro';
    mount();
    consumer!({ files: [handle('invite.ics')] });
    await flush();
    expect(hoisted.push).toHaveBeenCalledWith('/calendar');
  });

  it('says so for a file it cannot handle', async () => {
    mount();
    consumer!({ files: [handle('photo.png', 'image/png')] });
    await flush();
    expect(hoisted.toastError).toHaveBeenCalledWith('unsupported_file');
    expect(pendingHandoffs()).toEqual([]);
  });

  it('says so for a file it cannot read', async () => {
    mount();
    consumer!({ files: [{ kind: 'file', getFile: async () => { throw new Error('denied'); } }] });
    await flush();
    expect(hoisted.toastError).toHaveBeenCalledWith('open_failed');
  });

  it('waits on the sign-in page, and goes on after it', async () => {
    hoisted.pathname.current = '/login';
    const view = mount();
    consumer!({ files: [handle('invite.ics')] });
    await flush();
    expect(hoisted.push).not.toHaveBeenCalled();

    hoisted.pathname.current = '/';
    view.rerender(<ProtocolLaunchHandlerProvider><div>app</div></ProtocolLaunchHandlerProvider>);
    await flush();
    expect(hoisted.push).toHaveBeenCalledTimes(1);
    expect(hoisted.push).toHaveBeenCalledWith('/calendar');
  });

  it('goes to the page only once for a handoff, so it does not trap a later visit elsewhere', async () => {
    hoisted.pathname.current = '/settings';
    const view = mount();
    consumer!({ files: [handle('invite.ics')] });
    await flush();
    expect(hoisted.push).toHaveBeenCalledTimes(1);

    hoisted.pathname.current = '/mail';
    view.rerender(<ProtocolLaunchHandlerProvider><div>app</div></ProtocolLaunchHandlerProvider>);
    await flush();
    expect(hoisted.push).toHaveBeenCalledTimes(1);
  });
});

describe('launches that are not files', () => {
  it('still handles mailto:', async () => {
    mount();
    consumer!({ targetURL: `${window.location.origin}/protocol/mailto?url=${encodeURIComponent('mailto:a@example.org')}` });
    await waitFor(() => expect(hoisted.savePendingMailto).toHaveBeenCalled());
    expect(hoisted.savePendingMailto.mock.calls[0][0].to).toEqual(['a@example.org']);
  });

  it('opens a new message from the shortcut in an open window', async () => {
    hoisted.pathname.current = '/settings';
    mount();
    consumer!({ targetURL: `${window.location.origin}/?compose=1` });
    await flush();
    expect(hoisted.push).toHaveBeenCalledWith('/');
    expect(takeHandoff('compose')).toMatchObject({ files: [] });
  });

  it('goes to the calendar from its shortcut in an open window', async () => {
    mount();
    consumer!({ targetURL: `${window.location.origin}/calendar` });
    expect(hoisted.push).toHaveBeenCalledWith('/calendar');
  });

  it('leaves an open window where it is for the plain app icon', async () => {
    hoisted.pathname.current = '/settings';
    mount();
    consumer!({ targetURL: `${window.location.origin}/` });
    await flush();
    expect(hoisted.push).not.toHaveBeenCalled();
    expect(pendingHandoffs()).toEqual([]);
  });

  it('ignores a launch of the share target: the service worker has that', async () => {
    mount();
    consumer!({ targetURL: `${window.location.origin}/protocol/share` });
    await flush();
    expect(hoisted.push).not.toHaveBeenCalled();
    expect(hoisted.toastError).not.toHaveBeenCalled();
  });

  it('asks launchQueue once per consumer: never a second one on one render', () => {
    mount();
    expect(setConsumer).toHaveBeenCalledTimes(1);
  });
});

describe('the address a launch lands on', () => {
  it('opens a new message once and removes the parameter', async () => {
    window.history.replaceState(null, '', '/?compose=1&slot=2#x');
    mount();
    expect(window.location.search).toBe('?slot=2');
    expect(window.location.hash).toBe('#x');
    expect(takeHandoff('compose')).toMatchObject({ files: [] });
    expect(takeHandoff('compose')).toBeNull();
  });

  it('counts the same launch once when launchQueue names it too', async () => {
    window.history.replaceState(null, '', '/?compose=1');
    mount();
    consumer!({ targetURL: `${window.location.origin}/?compose=1` });
    await flush();
    expect(takeHandoff('compose')).not.toBeNull();
    expect(takeHandoff('compose')).toBeNull();
  });

  it('turns text in the address into a draft and says the files were lost', async () => {
    window.history.replaceState(null, '', '/?share=unavailable&share_title=T&share_text=B&share_files=1');
    mount();
    expect(window.location.search).toBe('');
    expect(takeHandoff('compose')).toMatchObject({ subject: 'T', body: 'B' });
    expect(hoisted.toastError).toHaveBeenCalledWith('share_files_lost');
  });

  it('says so when what was shared is gone', async () => {
    window.history.replaceState(null, '', '/?share=abc');
    mount();
    expect(window.location.search).toBe('');
    await flush();
    expect(hoisted.toastError).toHaveBeenCalledWith('share_gone');
  });
});

describe('a browser without launchQueue', () => {
  it('renders the app and does nothing else', async () => {
    delete window.launchQueue;
    mount();
    await flush();
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(setConsumer).not.toHaveBeenCalled();
    expect(hoisted.push).not.toHaveBeenCalled();
    expect(pendingHandoffs()).toEqual([]);
  });
});
