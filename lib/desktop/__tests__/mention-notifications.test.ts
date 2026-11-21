import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopOsNotification } from '../types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { NoteEntry } from '@/lib/team-mailboxes/note-format';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';

/** A mention of the user in a team note, as a desktop notification, and what its click opens. */

const playNotificationSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound }));

let pushWithoutContent = false;
vi.mock('@/lib/device-policy', () => ({ devicesForAccount: () => ({ pushWithoutContent }) }));

const accounts = [{ id: 'bob@one', cookieSlot: 2, serverUrl: 'https://one.example', username: 'bob@example.org', label: 'Work', email: 'bob@example.org' }];
vi.mock('@/stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ isAuthenticated: true, activeAccountId: 'bob@one' }), subscribe: () => () => {} },
}));

type Listener = (event: { ref: TeamRef; client: IJMAPClient; note: NoteEntry }) => void;
const arrivals = vi.hoisted(() => ({ listeners: new Set<Listener>() }));
vi.mock('@/lib/team-mailboxes/mention-watcher', () => ({
  onMention: (listener: Listener) => {
    arrivals.listeners.add(listener);
    return () => arrivals.listeners.delete(listener);
  },
}));

const REF: TeamRef = { key: 'bob@one|g', loginId: 'bob@one', accountId: 'g', groupAddress: 'team@example.org' };
const LABELS = {
  mentionedYou: (name: string, subject: string) => `${name} mentioned you in “${subject}”`,
  mentionedHidden: 'You were mentioned in a team mailbox',
};

function note(over: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id: 'n1', messageId: 'n1@notes.bulwark.invalid', key: 'offer@client.example', threadId: 'T1', kind: 'note',
    author: { name: 'Mabel', email: 'mabel@example.org' }, at: Date.now() - 5_000, mentions: ['bob', 'carol'],
    text: 'Waiting for the signed copy', subject: 'Offer for the Mulberry project', ...over,
  };
}

const client = {
  getAccountId: () => 'bob',
  getUsername: () => 'bob@example.org',
  getThread: vi.fn(async (id: string) => (id === 'T1' ? { id, emailIds: ['offer', 'reply'] } : null)),
  getTeamNotes: vi.fn(async (_account: string, ids: readonly string[]) => ({
    list: ids.map((id) => ({ id, messageId: [id === 'offer' ? '<offer@client.example>' : `${id}@client.example`] })),
    notFound: [],
  })),
} as unknown as IJMAPClient;

let shown: DesktopOsNotification[] = [];
function setBridge(on: boolean) {
  window.bulwarkDesktop = (on
    ? { version: 1, platform: 'win32', os: { notify: vi.fn(async (n: DesktopOsNotification) => { shown.push(n); return { shown: true, playSound: true }; }) } }
    : undefined) as BulwarkDesktopBridge | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  shown = [];
  pushWithoutContent = false;
  setBridge(true);
  const { useSettingsStore } = await import('@/stores/settings-store');
  useSettingsStore.setState({
    emailNotificationsEnabled: true,
    emailNotificationSound: true,
    doNotDisturb: false,
    notificationMutes: { accounts: [], mailboxes: {} },
  });
  const { setAppLockCheck } = await import('../app-lock-state');
  setAppLockCheck(null);
  const { usePolicyStore } = await import('@/stores/policy-store');
  usePolicyStore.setState({ loaded: true });
  const { resetToldMentions } = await import('../mention-notifications');
  resetToldMentions();
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('a mention in a team note', () => {
  it('notifies the user it mentions, with author and subject, and opens the message it is about at the note', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    expect(await notifyDesktopMention(REF, client, note(), LABELS)).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Mabel mentioned you in “Offer for the Mulberry project”', body: '', id: 'mention:bob@one|g/n1' });
    expect(JSON.parse(shown[0].context)).toEqual({
      accountId: 'g', threadId: 'T1', note: 'n1', emailId: 'offer', slot: 2,
      login: await loginFingerprint('https://one.example', 'bob@example.org'),
    });
    expect(playNotificationSound).toHaveBeenCalled();
  });

  it('says only that the user was mentioned when the organisation keeps content off', async () => {
    pushWithoutContent = true;
    const { notifyDesktopMention } = await import('../mention-notifications');
    await notifyDesktopMention(REF, client, note(), LABELS);
    expect(shown[0].title).toBe('You were mentioned in a team mailbox');
    expect(JSON.stringify(shown[0])).not.toMatch(/Mabel|Mulberry|signed copy/);
  });

  it('says nothing to a member it does not mention, by exact id', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    expect(await notifyDesktopMention(REF, client, note({ mentions: ['carol', 'bobby', 'ob'] }), LABELS)).toBe(false);
    expect(shown).toEqual([]);
  });

  it('says nothing for a timeline entry that names the user', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    expect(await notifyDesktopMention(REF, client, note({ kind: 'assigned', mentions: ['bob'], text: '' }), LABELS)).toBe(false);
    expect(shown).toEqual([]);
  });

  it("says nothing for the user's own note", async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    expect(await notifyDesktopMention(REF, client, note({ author: { name: 'Bob', email: 'bob@example.org' } }), LABELS)).toBe(false);
    expect(shown).toEqual([]);
  });

  it('tells each note once, whoever reports it', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    await notifyDesktopMention(REF, client, note(), LABELS);
    await notifyDesktopMention(REF, client, note(), LABELS);
    expect(shown).toHaveLength(1);
  });

  it('keeps two logins apart when their account and note ids are the same', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    await notifyDesktopMention(REF, client, note(), LABELS);
    await notifyDesktopMention({ ...REF, key: 'bob@two|g', loginId: 'bob@two' }, client, note(), LABELS);
    expect(new Set(shown.map((n) => n.id)).size).toBe(2);
  });

  it('is not told again when Undo brings the note back under a new id', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    await notifyDesktopMention(REF, client, note(), LABELS);
    expect(await notifyDesktopMention(REF, client, note({ id: 'n1-again' }), LABELS)).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('follows mail notifications off and Do not disturb', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ doNotDisturb: true });
    expect(await notifyDesktopMention(REF, client, note(), LABELS)).toBe(false);
    useSettingsStore.setState({ doNotDisturb: false, emailNotificationsEnabled: false });
    expect(await notifyDesktopMention(REF, client, note({ id: 'n2' }), LABELS)).toBe(false);
    expect(shown).toEqual([]);
  });

  it('does nothing outside the desktop app', async () => {
    setBridge(false);
    const { notifyDesktopMention } = await import('../mention-notifications');
    expect(await notifyDesktopMention(REF, client, note(), LABELS)).toBe(false);
  });

  it('comes from the mentions the watcher reports, while mail notifications run', async () => {
    const { startMailNotifications } = await import('../mail-notifications');
    const labels = {
      newMail: 'new_mail', newMailCount: (count: number) => `count:${count}`, noSubject: 'no_subject', archive: null,
      markRead: 'mark_read', delete: 'delete', reply: 'reply', replyPlaceholder: 'placeholder', copyCode: (code: string) => code,
      mention: LABELS,
    };
    const mail = startMailNotifications(labels);
    for (const listener of arrivals.listeners) {
      listener({ ref: REF, client, note: note({ mentions: ['carol'] }) });
      listener({ ref: REF, client, note: note({ id: 'n2' }) });
    }
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].id).toBe('mention:bob@one|g/n2');
    mail.stop();
    expect(arrivals.listeners.size).toBe(0);
  });
});

describe('clicking it', () => {
  it('opens the message in the team mailbox, at the note', async () => {
    const { notifyDesktopMention } = await import('../mention-notifications');
    await notifyDesktopMention(REF, client, note(), LABELS);
    const { setMailLinkOpener, resetMailLinks } = await import('../mail-links');
    const { handleOsCommand } = await import('../os-commands');
    const opened = vi.fn();
    resetMailLinks();
    const stop = setMailLinkOpener(opened);
    await handleOsCommand({ type: 'notification', action: '', context: shown[0].context }, {
      leaveFor: vi.fn(), push: vi.fn(), notifyFailed: vi.fn(), notifyReplyLost: vi.fn(),
    });
    stop();
    expect(opened).toHaveBeenCalledWith({ kind: 'message', id: 'offer', slot: 2, ownerAccountId: 'g', note: 'n1' }, undefined);
  });
});
