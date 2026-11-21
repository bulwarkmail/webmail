import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The overlay on every screen: what shows for a drag from outside, where a drop goes, and
// the same choices as a dialog for a pasted file or one opened with the desktop app.

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: { current: '/' },
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  locked: { current: false },
  flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: hoisted.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => hoisted.pathname.current,
}));
vi.mock('@/stores/toast-store', () => ({ toast: { error: hoisted.toastError, info: hoisted.toastInfo, success: hoisted.toastSuccess } }));
vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: hoisted.flushComposers }));
vi.mock('@/lib/desktop/app-lock-state', () => ({ isAppLocked: () => hoisted.locked.current }));

const { useAuthStore } = await import('@/stores/auth-store');
const { clearHandoffs, takeHandoff } = await import('@/lib/launch-handoff');
const { setComposerFileTarget, setOwnDragActive } = await import('@/lib/desktop/window-files');
const { setFilesDropTarget, takeQueuedFilesUpload } = await import('@/lib/file-drop/files-target');
const { requestFileChoice } = await import('@/lib/file-drop/choice');
const { FileDropHost } = await import('../file-drop-host');

interface FakeClient {
  supportsFiles: () => boolean;
  supportsContacts: () => boolean;
  getMaxSizeUpload: () => number;
  getMaxSizeAttachmentsPerEmail: () => number;
}

function signIn(client: Partial<FakeClient> = {}) {
  useAuthStore.setState({
    isAuthenticated: true,
    activeAccountId: null,
    client: {
      supportsFiles: () => true,
      supportsContacts: () => false,
      getMaxSizeUpload: () => 0,
      getMaxSizeAttachmentsPerEmail: () => 0,
      ...client,
    } as never,
  });
}

function transfer(files: File[]) {
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) })),
    dropEffect: 'none',
  };
}

/** A drag from outside reaching the window, as the browser sends it. */
function dragIn(files: File[]) {
  const event = new Event('dragenter', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer(files) });
  act(() => {
    document.body.dispatchEvent(event);
  });
}

function zone(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="file-drop-overlay"] [data-drop-zone="${id}"]`);
  if (!found) throw new Error(`no zone ${id}`);
  return found;
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' });

beforeEach(() => {
  clearHandoffs();
  takeHandoff('compose');
  takeQueuedFilesUpload();
  hoisted.locked.current = false;
  hoisted.pathname.current = '/';
  vi.clearAllMocks();
  signIn();
});

afterEach(() => {
  setOwnDragActive(false);
  useAuthStore.setState({ isAuthenticated: false, client: null });
});

describe('a drag from outside', () => {
  it('covers the window with the two main choices and says how many files', () => {
    render(<FileDropHost />);
    dragIn([file, file]);
    expect(screen.getByTestId('file-drop-overlay')).toBeTruthy();
    expect(zone('new-message').textContent).toContain('zone_new_message');
    expect(zone('upload').textContent).toContain('zone_upload_files');
    expect(screen.getByTestId('file-drop-count').textContent).toBe('files_summary:{"count":2}');
  });

  it('a drop on "Attach to a new message" starts a draft with the file', async () => {
    render(<FileDropHost />);
    dragIn([file]);
    fireEvent.drop(zone('new-message'), { dataTransfer: transfer([file]) });
    await flush();
    expect(takeHandoff('compose')?.files).toEqual([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
  });

  it('with a composer on screen, its zone comes first and takes the file', async () => {
    const take = vi.fn();
    const clear = setComposerFileTarget(take, () => true);
    render(<FileDropHost />);
    dragIn([file]);
    const zones = Array.from(document.querySelectorAll('[data-drop-zone]')).map((element) => element.getAttribute('data-drop-zone'));
    expect(zones[0]).toBe('attach-here');
    fireEvent.drop(zone('attach-here'), { dataTransfer: transfer([file]) });
    await flush();
    expect(take).toHaveBeenCalledWith([file]);
    expect(takeHandoff('compose')).toBeNull();
    clear();
  });

  it('a picture dropped on "Insert into the message" goes into the text, as a paste would', async () => {
    const take = vi.fn();
    const insert = vi.fn();
    const clear = setComposerFileTarget(take, () => true, { available: () => true, insert });
    const picture = new File(['png'], 'chart.png', { type: 'image/png' });
    render(<FileDropHost />);
    dragIn([picture]);
    expect(zone('insert-inline').textContent).toContain('zone_insert_inline');
    fireEvent.drop(zone('insert-inline'), { dataTransfer: transfer([picture]) });
    await flush();
    expect(insert).toHaveBeenCalledWith([picture]);
    expect(take).not.toHaveBeenCalled();
    clear();
  });

  // pim-p2-6: on the Files screen a drop uploads where it lands, with no question; the
  // list takes it (components/files). A file pasted there goes up into the folder in view.
  it('on the Files screen, shows no choices and leaves the drop to the list', async () => {
    const take = vi.fn();
    const clear = setFilesDropTarget({ folder: 'Reports', take, visible: () => true });
    try {
      render(<FileDropHost />);
      dragIn([file]);
      expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
      act(() => requestFileChoice({ files: [file] }));
      await flush();
      expect(screen.queryByTestId('file-drop-choice')).toBeNull();
      expect(take).toHaveBeenCalledWith({ files: [file], asFolder: false });
    } finally {
      clear();
    }
  });

  it('from another screen, Files gets the files after the app goes there', async () => {
    render(<FileDropHost />);
    dragIn([file]);
    fireEvent.drop(zone('upload'), { dataTransfer: transfer([file]) });
    await flush();
    expect(hoisted.push).toHaveBeenCalledWith('/files');
    expect(takeQueuedFilesUpload()).toEqual({ files: [file], asFolder: false });
  });

  it('a drop beside the zones does nothing', async () => {
    render(<FileDropHost />);
    dragIn([file]);
    fireEvent.drop(screen.getByTestId('file-drop-overlay'), { dataTransfer: transfer([file]) });
    await flush();
    expect(takeHandoff('compose')).toBeNull();
    expect(takeQueuedFilesUpload()).toBeNull();
  });

  it('a file over the server limit is named and left out before anything starts', async () => {
    signIn({ getMaxSizeUpload: () => 3 });
    render(<FileDropHost />);
    dragIn([file]);
    expect(zone('upload').textContent).toContain('note_limit_file');
    fireEvent.drop(zone('upload'), { dataTransfer: transfer([file]) });
    await flush();
    expect(hoisted.toastError).toHaveBeenCalledWith(expect.stringContaining('too_large_file'));
    expect(takeQueuedFilesUpload()).toBeNull();
  });

  it('the app\'s own drags never bring it up', () => {
    render(<FileDropHost />);
    act(() => {
      document.body.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    dragIn([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
    });
    setOwnDragActive(true);
    dragIn([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
  });

  it('nothing while the app is locked, signed out, or behind a dialog of its own', () => {
    render(<FileDropHost />);
    hoisted.locked.current = true;
    dragIn([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
    hoisted.locked.current = false;
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('aria-modal', 'true');
    dragIn([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
    dialog.remove();
    useAuthStore.setState({ isAuthenticated: false });
    dragIn([file]);
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
  });

  it('leaves Files out on a server without it', () => {
    signIn({ supportsFiles: () => false });
    render(<FileDropHost />);
    dragIn([file]);
    expect(document.querySelector('[data-drop-zone="upload"]')).toBeNull();
    expect(zone('new-message')).toBeTruthy();
  });

  it('dragging out of the window takes it away', () => {
    render(<FileDropHost />);
    dragIn([file]);
    const leave = new Event('dragleave', { bubbles: true });
    Object.defineProperty(leave, 'relatedTarget', { value: null });
    act(() => {
      screen.getByTestId('file-drop-overlay').dispatchEvent(leave);
    });
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
  });
});

describe('the same choices without a drag', () => {
  function paste(target: EventTarget, files: File[], types = ['Files']) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, types } });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('a file pasted outside a text field asks, with the focus on a new message, and Enter takes it', async () => {
    render(<FileDropHost />);
    expect(paste(document.body, [file]).defaultPrevented).toBe(true);
    const dialog = await screen.findByTestId('file-drop-choice');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-drop-zone')).toBe('new-message'));
    expect(dialog.querySelector('[data-drop-zone="upload"]')).toBeTruthy();
    fireEvent.click(document.activeElement as HTMLElement);
    await flush();
    expect(takeHandoff('compose')?.files).toEqual([file]);
    expect(screen.queryByTestId('file-drop-choice')).toBeNull();
  });

  it('arrow keys move between the choices', async () => {
    render(<FileDropHost />);
    paste(document.body, [file]);
    await screen.findByTestId('file-drop-choice');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-drop-zone')).toBe('new-message'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-drop-zone')).toBe('upload');
  });

  it('with only one thing to do, it does it without asking', async () => {
    signIn({ supportsFiles: () => false });
    render(<FileDropHost />);
    paste(document.body, [file]);
    await flush();
    expect(screen.queryByTestId('file-drop-choice')).toBeNull();
    expect(takeHandoff('compose')?.files).toEqual([file]);
  });

  it('pasted text, or a file in a search field, is left alone', () => {
    render(<FileDropHost />);
    expect(paste(document.body, [file], ['text/plain', 'Files']).defaultPrevented).toBe(false);
    const input = document.body.appendChild(document.createElement('input'));
    expect(paste(input, [file]).defaultPrevented).toBe(false);
    input.remove();
    expect(screen.queryByTestId('file-drop-choice')).toBeNull();
  });

  it('a bare file pasted into a composer on screen attaches to it', () => {
    const take = vi.fn();
    const clear = setComposerFileTarget(take, () => true);
    render(<FileDropHost />);
    const composer = document.body.appendChild(document.createElement('div'));
    composer.setAttribute('data-testid', 'email-composer');
    const body = composer.appendChild(document.createElement('div'));
    body.setAttribute('contenteditable', 'true');
    paste(body, [file]);
    expect(take).toHaveBeenCalledWith([file]);
    composer.remove();
    clear();
  });

  it('a file opened with the desktop app gets the dialog, and waits for a sign-in', async () => {
    useAuthStore.setState({ isAuthenticated: false });
    render(<FileDropHost />);
    act(() => requestFileChoice({ files: [file], preferred: 'new-message' }));
    expect(screen.queryByTestId('file-drop-choice')).toBeNull();
    act(() => signIn());
    expect(await screen.findByTestId('file-drop-choice')).toBeTruthy();
  });
});

// "Import into <folder>" for a dropped .eml: the folder on screen is a folder
// of the login browsed. With another login's Inbox open in the Pro sidebar
// the message goes into that Inbox, through that login, and not into the
// active login's folder with the same id.
describe('an .eml dropped on the folder in view', () => {
  const eml = new File(['Subject: note\r\n\r\nhello'], 'note.eml', { type: 'message/rfc822' });
  const inbox = (accountId: string) => ({ id: 'a', name: 'Inbox', role: 'inbox', accountId, myRights: { mayAddItems: true } });
  const loginClient = () => ({
    supportsFiles: () => false, supportsContacts: () => false, getMaxSizeUpload: () => 0, getMaxSizeAttachmentsPerEmail: () => 0,
    importRawEmail: vi.fn(async (_file: File, _mailboxIds: Record<string, boolean>, _keywords?: unknown, _accountId?: string) => 'new-id'),
  });
  let active: ReturnType<typeof loginClient>;
  let other: ReturnType<typeof loginClient>;
  let connected: Map<string, ReturnType<typeof loginClient>>;
  let emailStore: typeof import('@/stores/email-store').useEmailStore;
  let before: ReturnType<typeof emailStore.getState>;

  beforeEach(async () => {
    emailStore = (await import('@/stores/email-store')).useEmailStore;
    before = emailStore.getState();
    active = loginClient();
    other = loginClient();
    connected = new Map([['login-a', active], ['login-b', other]]);
    useAuthStore.setState({
      isAuthenticated: true, activeAccountId: 'login-a', client: active as never,
      getClientForAccount: ((id: string) => connected.get(id)) as never,
    });
    emailStore.setState({
      selectedMailbox: 'a', viewingAccountId: 'login-b',
      mailboxes: [inbox('ee')], accountMailboxes: { 'login-b': [inbox('ef')] },
    } as never);
    hoisted.pathname.current = '/mail/folder/inbox';
  });
  afterEach(() => {
    emailStore.setState(before);
    useAuthStore.setState({ activeAccountId: null, getClientForAccount: (() => undefined) as never });
  });

  const dropOnImport = async () => {
    render(<FileDropHost />);
    dragIn([eml]);
    fireEvent.drop(zone('import-eml'), { dataTransfer: transfer([eml]) });
    await flush();
    await flush();
  };

  it('of another login goes into that login\'s folder, through that login', async () => {
    await dropOnImport();
    expect(other.importRawEmail).toHaveBeenCalledTimes(1);
    expect(other.importRawEmail.mock.calls[0].slice(1, 4)).toEqual([{ a: true }, expect.anything(), 'ef']);
    expect(active.importRawEmail).not.toHaveBeenCalled();
  });

  it('of another login that has no client is not offered, and nothing goes to the active login', async () => {
    connected.delete('login-b');
    render(<FileDropHost />);
    dragIn([eml]);
    expect(document.querySelector('[data-drop-zone="import-eml"]')).toBeNull();
    expect(active.importRawEmail).not.toHaveBeenCalled();
  });

  it('of the active login goes into its own folder, as before', async () => {
    emailStore.setState({ viewingAccountId: null } as never);
    await dropOnImport();
    expect(active.importRawEmail).toHaveBeenCalledTimes(1);
    expect(active.importRawEmail.mock.calls[0][3]).toBe('ee');
    expect(other.importRawEmail).not.toHaveBeenCalled();
  });
});
