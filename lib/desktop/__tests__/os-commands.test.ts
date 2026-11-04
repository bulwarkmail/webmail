import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopOsCommand } from '../types';
import type { NotificationActionRequest, NotificationActionStatus } from '@/lib/pwa-notify/page-actions';

/** What the OS asks for, carried out by the parts the app already has. */

const runNotificationAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pwa-notify/page-actions', () => ({ runNotificationAction }));

const accounts = [{ id: 'alice@one', cookieSlot: 3, serverUrl: 'https://one.example', username: 'alice@example.org' }];
let authenticated = true;
vi.mock('@/stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ isAuthenticated: authenticated }),
    subscribe: () => () => {},
  },
}));

const session = vi.hoisted(() => ({
  savePendingMailto: vi.fn(),
  notifyPendingMailto: vi.fn(),
  savePendingWebcal: vi.fn(),
  notifyPendingWebcal: vi.fn(),
}));
vi.mock('@/lib/protocol-handlers/session', () => session);

async function fingerprint() {
  const { loginFingerprint } = await import('@/lib/pwa-notify/login-fingerprint');
  return loginFingerprint('https://one.example', 'alice@example.org');
}

const leaveFor = vi.fn();
const push = vi.fn();
const notifyFailed = vi.fn();
const notifyReplyLost = vi.fn();
const env = { leaveFor, push, notifyFailed, notifyReplyLost };
const focus = vi.fn();

async function run(command: DesktopOsCommand) {
  const { handleOsCommand } = await import('../os-commands');
  await handleOsCommand(command, env);
}

const text = (value: string) => new TextEncoder().encode(value);

// The handler pulls in much of the app the first time; load it once here, with room to spare,
// so the first test isn't the one that times out on a busy machine.
beforeAll(async () => {
  await import('../os-commands');
}, 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  authenticated = true;
  window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus } } as unknown as BulwarkDesktopBridge;
  const { resetMailLinks } = await import('../mail-links');
  resetMailLinks();
  const { clearHandoffs, takeHandoff } = await import('@/lib/launch-handoff');
  clearHandoffs();
  for (const kind of ['compose', 'eml', 'calendar', 'contacts'] as const) takeHandoff(kind);
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('launches', () => {
  it('New message goes through the launch handoff, with no question asked', async () => {
    const { subscribeHandoff } = await import('@/lib/launch-handoff');
    const fired = vi.fn();
    const stop = subscribeHandoff('compose', fired);
    await run({ type: 'new-message' });
    expect(fired).toHaveBeenCalled();
    stop();
  });

  it('a mailto goes through the protocol handler to the mail page', async () => {
    await run({ type: 'mailto', url: 'mailto:bob@example.org?subject=Hi&body=Text' });
    expect(session.savePendingMailto).toHaveBeenCalledTimes(1);
    expect(session.savePendingMailto.mock.calls[0][0]).toMatchObject({ to: ['bob@example.org'], subject: 'Hi' });
    expect(session.notifyPendingMailto).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/');
  });

  it('a mailto from the OS is marked so, opens in its own window, and leaves the main window be', async () => {
    await run({ type: 'mailto', url: 'mailto:bob@example.org' });
    expect(session.savePendingMailto.mock.calls[0][0]).toMatchObject({ fromOs: true });
    expect(focus).not.toHaveBeenCalled();
  });

  it('signed out, the main window comes up for the sign-in', async () => {
    authenticated = false;
    await run({ type: 'mailto', url: 'mailto:bob@example.org' });
    expect(focus).toHaveBeenCalled();
  });

  it('a mailto that is not one does nothing', async () => {
    await run({ type: 'mailto', url: 'mailto:' + '%'.repeat(3) });
    expect(push).not.toHaveBeenCalledWith('/calendar');
  });

  it('a webcal goes to the calendar', async () => {
    await run({ type: 'webcal', url: 'webcal://example.org/cal.ics' });
    expect(session.savePendingWebcal).toHaveBeenCalledTimes(1);
    expect(session.notifyPendingWebcal).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/calendar');
  });

  it('a double-clicked .eml, .ics and .vcf each reach their handler', async () => {
    const { takeHandoff } = await import('@/lib/launch-handoff');
    await run({
      type: 'files',
      reason: 'open',
      failed: [],
      files: [
        { name: 'letter.eml', data: text('Subject: x') },
        { name: 'party.ics', data: text('BEGIN:VCALENDAR') },
        { name: 'bob.vcf', data: text('BEGIN:VCARD') },
      ],
    });
    expect(await takeHandoff('eml')?.files[0].text()).toBe('Subject: x');
    expect(takeHandoff('calendar')?.files[0].name).toBe('party.ics');
    expect(takeHandoff('contacts')?.files[0].name).toBe('bob.vcf');
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it('a file dropped on the icon becomes an attachment on a new draft', async () => {
    const { takeHandoff } = await import('@/lib/launch-handoff');
    await run({ type: 'files', reason: 'attach', failed: [], files: [{ name: 'report.pdf', data: text('pdf') }] });
    const draft = takeHandoff('compose');
    expect(draft?.files.map((file) => file.name)).toEqual(['report.pdf']);
  });

  it('several files sent to the app go on one draft, without a question', async () => {
    const { takeHandoff } = await import('@/lib/launch-handoff');
    await run({ type: 'files', reason: 'attach', failed: [], files: [{ name: 'a.pdf', data: text('a') }, { name: 'b.png', data: text('b') }] });
    expect(takeHandoff('compose')?.files.map((file) => file.name)).toEqual(['a.pdf', 'b.png']);
  });

  it('files sent from another program are marked so, for a compose window of their own, as a mail link', async () => {
    const { takeHandoff } = await import('@/lib/launch-handoff');
    await run({ type: 'files', reason: 'attach', failed: [], files: [{ name: 'a.pdf', data: text('a') }] });
    expect(takeHandoff('compose')).toMatchObject({ fromOs: true });
  });

  it('a file opened with the app asks: new message or Files, a new message first', async () => {
    const { takeHandoff } = await import('@/lib/launch-handoff');
    const { listenForFileChoices } = await import('@/lib/file-drop/choice');
    const asked = vi.fn();
    const stop = listenForFileChoices(asked);
    await run({ type: 'files', reason: 'attach', ask: true, failed: [], files: [{ name: 'report.pdf', data: text('pdf') }] });
    expect(asked).toHaveBeenCalledWith({ files: [expect.objectContaining({ name: 'report.pdf' })], preferred: 'new-message' });
    expect(takeHandoff('compose')).toBeNull();
    stop();
  });

  it('says so when a file could not be read', async () => {
    await run({ type: 'files', reason: 'open', failed: ['gone.eml'], files: [] });
    expect(notifyFailed).toHaveBeenCalledWith(['gone.eml']);
  });
});

describe('going somewhere', () => {
  it('Calendar and Contacts leave through the save-first path', async () => {
    await run({ type: 'navigate', target: 'calendar' });
    expect(leaveFor).toHaveBeenCalledWith('/calendar');
  });

  it('Inbox opens the folder on the mail page when it is mounted', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'navigate', target: 'inbox' });
    expect(opener).toHaveBeenCalledWith({ kind: 'folder', ref: 'inbox' }, undefined);
    expect(leaveFor).not.toHaveBeenCalled();
    stop();
  });

  it('with the mail page not mounted the link waits for it, and the app goes there', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    await run({ type: 'open-message', emailId: 'e1', accountId: 'acc' });
    expect(leaveFor).toHaveBeenCalledWith('/');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    expect(opener).toHaveBeenCalledWith({ kind: 'message', id: 'e1', ownerAccountId: 'acc' }, undefined);
    stop();
  });
});

describe('a toast\'s buttons', () => {
  const context = async (over: object = {}) => JSON.stringify({ emailId: 'e1', threadId: 't1', accountId: 'acc', slot: 3, login: await fingerprint(), ...over });
  const finishWith = (status: NotificationActionStatus) => {
    runNotificationAction.mockImplementation(async (_request: NotificationActionRequest, answer: (s: NotificationActionStatus) => void) => {
      answer('accepted');
      answer(status);
    });
  };

  it.each(['archive', 'mark-read', 'delete'] as const)('%s runs through the page\'s notification action and stays out of sight', async (action) => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    finishWith('done');
    await run({ type: 'notification', action, context: await context() });
    expect(runNotificationAction.mock.calls[0][0]).toMatchObject({ action, emailId: 'e1', accountId: 'acc', slot: 3, login: await fingerprint() });
    expect(opener).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    stop();
  });

  it('a button that can\'t be carried out opens the message instead', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    finishWith('failed');
    await run({ type: 'notification', action: 'archive', context: await context() });
    expect(focus).toHaveBeenCalled();
    expect(opener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', id: 'e1', slot: 3 }), undefined);
    stop();
  });

  it('a reply opens the composer with the typed text, and is not sent', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'notification', action: 'reply', context: await context(), reply: 'On my way' });
    expect(runNotificationAction).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledWith(
      { kind: 'message', id: 'e1', slot: 3, ownerAccountId: 'acc', reply: true },
      { replyText: 'On my way' },
    );
    stop();
  });

  it('behind the app lock an old toast acts on nothing, and the window comes up', async () => {
    const { setAppLockCheck } = await import('../app-lock-state');
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    setAppLockCheck(() => true);
    for (const action of ['delete', 'archive', 'mark-read', 'open', 'reply']) {
      await run({ type: 'notification', action, context: await context(), reply: 'x' });
    }
    expect(runNotificationAction).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    setAppLockCheck(null);
    stop();
  });

  it('typed text that has nowhere to go says so', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const stop = setMailLinkOpener(vi.fn());
    await run({ type: 'notification', action: 'reply', context: await context({ login: 'someone-else' }), reply: 'On my way' });
    expect(notifyReplyLost).toHaveBeenCalled();
    notifyReplyLost.mockClear();
    await run({ type: 'notification', action: 'reply', context: await context({ login: 'someone-else' }) });
    expect(notifyReplyLost).not.toHaveBeenCalled();
    stop();
  });

  it('a click on an old toast whose slot went to someone else opens the Inbox, not their message', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'notification', action: 'open', context: await context({ login: 'someone-else' }) });
    expect(opener).toHaveBeenCalledWith({ kind: 'folder', ref: 'inbox' }, undefined);
    stop();
  });

  it('a toast for a saved attachment only brings the window up, and leaves the page where it is', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'notification', action: 'open', context: JSON.stringify({ editedFile: true }) });
    expect(focus).toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
    expect(leaveFor).not.toHaveBeenCalled();
    stop();
  });

  it('a click on a summary toast opens the Inbox of that login', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'notification', action: 'open', context: await context({ emailId: undefined }) });
    expect(opener).toHaveBeenCalledWith({ kind: 'folder', ref: 'inbox', slot: 3 }, undefined);
    stop();
  });

  it('junk in the context does no harm', async () => {
    const { setMailLinkOpener } = await import('../mail-links');
    const opener = vi.fn();
    const stop = setMailLinkOpener(opener);
    await run({ type: 'notification', action: 'archive', context: '{not json' });
    expect(runNotificationAction).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledWith({ kind: 'folder', ref: 'inbox' }, undefined);
    stop();
  });
});

describe('a Files on this computer notification (files-p3-5)', () => {
  it("answers the mass-delete question from its buttons, and a click opens the settings page", async () => {
    const { useFilesSyncStore } = await import('@/stores/files-sync-store');
    const confirmMassDelete = vi.fn(async () => {});
    useFilesSyncStore.setState({ controller: { confirmMassDelete } as never });
    const context = JSON.stringify({ filesSync: 'r1' });
    await run({ type: 'notification', action: 'files-delete', context });
    expect(confirmMassDelete).toHaveBeenLastCalledWith('r1', true);
    await run({ type: 'notification', action: 'files-restore', context });
    expect(confirmMassDelete).toHaveBeenLastCalledWith('r1', false);
    expect(leaveFor).not.toHaveBeenCalled();
    await run({ type: 'notification', action: 'open', context });
    expect(focus).toHaveBeenCalled();
    expect(leaveFor).toHaveBeenCalledWith('/settings/files_sync');
    expect(confirmMassDelete).toHaveBeenCalledTimes(2);
    useFilesSyncStore.getState().reset();
  });
});

describe("the tray's Pause syncing (files-p3-14)", () => {
  it('pauses and resumes every root', async () => {
    const { useFilesSyncStore } = await import('@/stores/files-sync-store');
    const setAllPaused = vi.fn(async () => {});
    useFilesSyncStore.setState({ controller: { setAllPaused } as never });
    await run({ type: 'files-sync', action: 'pause-all' });
    expect(setAllPaused).toHaveBeenLastCalledWith(true);
    await run({ type: 'files-sync', action: 'resume-all' });
    expect(setAllPaused).toHaveBeenLastCalledWith(false);
    useFilesSyncStore.getState().reset();
  });
});

describe('listening', () => {
  it('does nothing in a browser', async () => {
    window.bulwarkDesktop = undefined;
    const { startOsCommands } = await import('../os-commands');
    expect(() => startOsCommands(env)()).not.toThrow();
  });

  it('subscribes, and carries out what arrives', async () => {
    let listener: ((command: DesktopOsCommand) => void) | null = null;
    window.bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      os: { onCommand: (l: (command: DesktopOsCommand) => void) => { listener = l; return () => { listener = null; }; } },
    } as unknown as BulwarkDesktopBridge;
    const { startOsCommands } = await import('../os-commands');
    const stop = startOsCommands(env);
    listener!({ type: 'navigate', target: 'contacts' });
    await Promise.resolve();
    expect(leaveFor).toHaveBeenCalledWith('/contacts');
    stop();
    expect(listener).toBeNull();
  });
});
