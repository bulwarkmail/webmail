import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches } from '@/lib/__tests__/sw-harness';

// The launchQueue consumer. It is the only one the app may have: a second
// setConsumer replaces the first. Files used to be dropped here.

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: { current: '/' },
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })),
  peek: vi.fn(),
  adopt: vi.fn(),
  discard: vi.fn(async () => {}),
  savePendingMailto: vi.fn(),
  protocolOpenMode: 'active-session',
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: hoisted.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => hoisted.pathname.current,
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: hoisted.toastError, info: hoisted.toastInfo, success: vi.fn() } }));
vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: hoisted.flushComposers }));
vi.mock('@/lib/launch-handoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/launch-handoff')>()),
  peekStoredHandoff: hoisted.peek,
  adoptStoredHandoff: hoisted.adopt,
  discardStoredHandoff: hoisted.discard,
}));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: Object.assign(() => undefined, { getState: () => ({ protocolOpenMode: hoisted.protocolOpenMode }) }),
}));
// The desktop's commands have their own tests, and pull in every store.
vi.mock('@/lib/desktop/os-commands', () => ({ startOsCommands: () => () => {} }));
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

const { clearHandoffs, handOffFiles, pendingHandoffs, takeHandoff, HANDOFF_TTL_MS } = await import('@/lib/launch-handoff');
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
  hoisted.toastInfo.mockClear();
  hoisted.flushComposers.mockReset();
  hoisted.flushComposers.mockResolvedValue({ total: 0, settled: 0, failed: 0, timedOut: false });
  hoisted.peek.mockReset();
  hoisted.adopt.mockReset();
  hoisted.discard.mockClear();
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
    await flush();
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

describe('leaving a composer for a launched file', () => {
  it('saves what was typed first, then goes', async () => {
    const order: string[] = [];
    hoisted.flushComposers.mockImplementation(async () => { order.push('flush'); return { total: 1, settled: 1, failed: 0, timedOut: false }; });
    hoisted.push.mockImplementation(() => { order.push('push'); });
    mount();
    consumer!({ files: [handle('people.vcf')] });
    await flush();
    expect(order).toEqual(['flush', 'push']);
    hoisted.push.mockReset();
  });

  it.each([
    ['the server refused the save', { total: 1, settled: 1, failed: 1, timedOut: false }],
    ['the save took too long', { total: 1, settled: 0, failed: 0, timedOut: true }],
  ])('stays when %s, with the file still waiting', async (_name, result) => {
    hoisted.flushComposers.mockResolvedValue(result);
    mount();
    consumer!({ files: [handle('people.vcf')] });
    await flush();
    expect(hoisted.push).not.toHaveBeenCalled();
    expect(hoisted.toastError).toHaveBeenCalledWith('save_first_failed');
    expect(pendingHandoffs().map((h) => h.kind)).toEqual(['contacts']);
  });

  it('does not save for a .eml, which leaves nothing', async () => {
    mount();
    consumer!({ files: [handle('note.eml')] });
    await screen.findByTestId('eml-viewer');
    expect(hoisted.flushComposers).not.toHaveBeenCalled();
  });
});

describe('a handoff that goes without arriving', () => {
  it('says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mount();
    handOffFiles([new File(['x'], 'a.ics')], 'calendar');
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    takeHandoff('calendar');
    vi.useRealTimers();
    expect(hoisted.toastError).toHaveBeenCalledWith('handoff_expired');
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
});

describe('a share from an address anyone can make', () => {
  const dialogText = () => screen.getByTestId('share-confirm-details').textContent ?? '';
  const agree = () => fireEvent.click(screen.getByRole('button', { name: 'share_confirm_accept' }));
  const refuse = () => fireEvent.click(screen.getByRole('button', { name: 'share_confirm_decline' }));

  it('asks about text in the address, and starts nothing before the answer', async () => {
    window.history.replaceState(null, '', '/#share=unavailable&share_title=T&share_text=B&share_files=1&share_cut=1');
    mount();
    expect(window.location.hash).toBe('');
    await screen.findByText('share_confirm_message');
    expect(dialogText()).toContain('T');
    expect(pendingHandoffs()).toEqual([]);
    expect(hoisted.push).not.toHaveBeenCalled();

    agree();
    await flush();
    expect(takeHandoff('compose')).toMatchObject({ subject: 'T', body: 'B' });
    expect(hoisted.toastError).toHaveBeenCalledWith('share_files_lost');
    expect(hoisted.toastInfo).toHaveBeenCalledWith('share_cut');
  });

  it('starts nothing when refused', async () => {
    window.history.replaceState(null, '', '/#share=unavailable&share_text=B');
    mount();
    await screen.findByText('share_confirm_message');
    refuse();
    await flush();
    expect(pendingHandoffs()).toEqual([]);
  });

  it('only reports lost files when there was no text to ask about', async () => {
    window.history.replaceState(null, '', '/#share=unavailable&share_files=1');
    mount();
    await flush();
    expect(screen.queryByText('share_confirm_message')).toBeNull();
    expect(hoisted.toastError).toHaveBeenCalledWith('share_files_lost');
    expect(pendingHandoffs()).toEqual([]);
  });

  it('ignores it in the query, which reaches logs and any link', async () => {
    window.history.replaceState(null, '', '/?share=unavailable&share_text=B');
    mount();
    await flush();
    expect(screen.queryByText('share_confirm_message')).toBeNull();
    expect(pendingHandoffs()).toEqual([]);
  });

  it('asks about a stored share, naming the files, before anything is taken in', async () => {
    hoisted.peek.mockResolvedValue({ subject: 'S', body: '', files: ['invoice.exe'] });
    hoisted.adopt.mockResolvedValue(true);
    window.history.replaceState(null, '', '/#share=abc&key=k1');
    mount();
    expect(window.location.hash).toBe('');
    await screen.findByText('share_confirm_message');
    expect(hoisted.peek).toHaveBeenCalledWith('abc', 'k1');
    expect(dialogText()).toContain('invoice.exe');
    expect(hoisted.adopt).not.toHaveBeenCalledWith('abc', 'k1');

    agree();
    await waitFor(() => expect(hoisted.adopt).toHaveBeenCalledWith('abc', 'k1'));
    expect(hoisted.discard).not.toHaveBeenCalled();
  });

  it('asks in an installed-app window as well: link capturing can bring a POST there', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('standalone'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    hoisted.peek.mockResolvedValue({ subject: 'S', body: '', files: [] });
    window.history.replaceState(null, '', '/#share=abc&key=k1');
    mount();
    await screen.findByText('share_confirm_message');
    expect(hoisted.adopt).not.toHaveBeenCalledWith('abc', 'k1');
    window.matchMedia = original;
  });

  it('drops a stored share when refused', async () => {
    hoisted.peek.mockResolvedValue({ subject: 'S', body: '', files: ['invoice.exe'] });
    window.history.replaceState(null, '', '/#share=abc&key=k1');
    mount();
    await screen.findByText('share_confirm_message');
    refuse();
    await waitFor(() => expect(hoisted.discard).toHaveBeenCalledWith('abc'));
    expect(hoisted.adopt).not.toHaveBeenCalledWith('abc', 'k1');
  });

  it('says so when what was shared is gone', async () => {
    hoisted.peek.mockResolvedValue(null);
    window.history.replaceState(null, '', '/#share=abc&key=k1');
    mount();
    expect(window.location.hash).toBe('');
    await flush();
    expect(hoisted.toastError).toHaveBeenCalledWith('share_gone');
    expect(screen.queryByText('share_confirm_message')).toBeNull();
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
