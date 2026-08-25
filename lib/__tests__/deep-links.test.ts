import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildFolderRef,
  resolveFolderRef,
  buildMailPath,
  parseMailPath,
  buildCalendarPath,
  parseCalendarPath,
  formatLinkDate,
  parseLinkDate,
  buildContactsPath,
  parseContactsPath,
  buildFilesPath,
  parseFilesPath,
  buildSettingsPath,
  parseSettingsPath,
  matchSurface,
  SCHEDULED_MAILBOX_ID,
} from '@/lib/deep-links';
import {
  UNIFIED_MAILBOX_IDS,
  CROSS_VIEW_IDS,
  type Mailbox,
} from '@/lib/jmap/types';

function mailbox(partial: Partial<Mailbox> & { id: string }): Mailbox {
  return {
    name: partial.id,
    totalEmails: 0,
    unreadEmails: 0,
    ...partial,
  } as Mailbox;
}

const MAILBOXES: Mailbox[] = [
  mailbox({ id: 'a', role: 'inbox', name: 'Inbox' }),
  mailbox({ id: 'b', role: 'sent', name: 'Sent' }),
  mailbox({ id: 'c', name: 'Projects/2026' }),
  mailbox({ id: 'shared-a', role: 'inbox', name: 'Team Inbox', isShared: true, accountId: 'team' }),
];

// `appPath` bakes NEXT_PUBLIC_LOCALE_PREFIX / NEXT_PUBLIC_BASE_PATH at module
// load (mirroring how next.config.ts and i18n/routing.ts read them at build
// time), so prefix-mode cases have to re-import under a fresh env.
async function loadLinks(env: { localePrefix?: string; basePath?: string }) {
  vi.resetModules();
  if (env.localePrefix === undefined) delete process.env.NEXT_PUBLIC_LOCALE_PREFIX;
  else process.env.NEXT_PUBLIC_LOCALE_PREFIX = env.localePrefix;
  if (env.basePath === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
  else process.env.NEXT_PUBLIC_BASE_PATH = env.basePath;
  return import('@/lib/deep-links');
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LOCALE_PREFIX;
  delete process.env.NEXT_PUBLIC_BASE_PATH;
  vi.resetModules();
});

describe('appPath — locale prefix and mount prefix', () => {
  it('omits the locale in the default "never" mode', async () => {
    const { appPath } = await loadLinks({});
    expect(appPath('/mail/message/abc', 'de')).toBe('/mail/message/abc');
  });

  it('always prefixes the locale in "always" mode', async () => {
    const { appPath } = await loadLinks({ localePrefix: 'always' });
    expect(appPath('/mail/message/abc', 'de')).toBe('/de/mail/message/abc');
    expect(appPath('/', 'de')).toBe('/de');
  });

  it('prefixes only non-default locales in "as-needed" mode', async () => {
    const { appPath } = await loadLinks({ localePrefix: 'as-needed' });
    expect(appPath('/calendar', 'en')).toBe('/calendar');
    expect(appPath('/calendar', 'fr')).toBe('/fr/calendar');
  });

  it('applies the mount prefix on subpath deployments', async () => {
    const { appPath } = await loadLinks({ localePrefix: 'always', basePath: '/webmail' });
    expect(appPath('/mail/thread/t1', 'de')).toBe('/webmail/de/mail/thread/t1');
  });

  it('builds an absolute URL for copy-link', async () => {
    const { appUrl } = await loadLinks({});
    expect(appUrl('/mail/message/abc')).toBe(`${window.location.origin}/mail/message/abc`);
  });
});

describe('mail folder references', () => {
  it('uses the role name for the account\'s own well-known folders', () => {
    expect(buildFolderRef('a', MAILBOXES)).toBe('inbox');
    expect(buildFolderRef('b', MAILBOXES)).toBe('sent');
  });

  it('keeps the raw id for custom folders', () => {
    expect(buildFolderRef('c', MAILBOXES)).toBe('c');
  });

  it('keeps the raw id for shared folders so they don\'t claim the role alias', () => {
    expect(buildFolderRef('shared-a', MAILBOXES)).toBe('shared-a');
    expect(resolveFolderRef('inbox', MAILBOXES)).toBe('a');
  });

  it('aliases the virtual unified, cross-account and scheduled views', () => {
    expect(buildFolderRef(UNIFIED_MAILBOX_IDS.inbox)).toBe('unified-inbox');
    expect(buildFolderRef(CROSS_VIEW_IDS.unread)).toBe('cross-unread');
    expect(buildFolderRef(SCHEDULED_MAILBOX_ID)).toBe('scheduled');

    expect(resolveFolderRef('unified-inbox')).toBe(UNIFIED_MAILBOX_IDS.inbox);
    expect(resolveFolderRef('cross-unread')).toBe(CROSS_VIEW_IDS.unread);
    expect(resolveFolderRef('scheduled')).toBe(SCHEDULED_MAILBOX_ID);
  });

  it('prefers an exact id match over an alias', () => {
    const odd = [...MAILBOXES, mailbox({ id: 'inbox', name: 'A folder literally called inbox' })];
    expect(resolveFolderRef('inbox', odd)).toBe('inbox');
  });

  it('returns null for a role that this account does not have', () => {
    expect(resolveFolderRef('archive', MAILBOXES)).toBeNull();
  });
});

describe('mail paths', () => {
  it('round-trips folder, message and thread links', () => {
    const folder = buildMailPath({ mailboxId: 'c', emailId: null, threadId: null }, MAILBOXES);
    expect(folder).toBe('/mail/folder/c');
    expect(parseMailPath(['folder', 'c'])).toEqual({ kind: 'folder', ref: 'c', accountId: undefined });

    const message = buildMailPath({ mailboxId: 'a', emailId: 'm1', threadId: null }, MAILBOXES);
    expect(message).toBe('/mail/message/m1');
    expect(parseMailPath(['message', 'm1'])).toEqual({ kind: 'message', id: 'm1', accountId: undefined });

    const thread = buildMailPath({ mailboxId: 'a', emailId: 'm1', threadId: 't1' }, MAILBOXES);
    expect(thread).toBe('/mail/thread/t1');
    expect(parseMailPath(['thread', 't1'])).toEqual({ kind: 'thread', id: 't1', accountId: undefined });
  });

  it('reads the fullscreen marker on message links', () => {
    expect(parseMailPath(['message', 'm1'], new URLSearchParams('view=fullscreen'))).toEqual({
      kind: 'message',
      id: 'm1',
      accountId: undefined,
      fullscreen: true,
    });
    expect(parseMailPath(['message', 'm1'], new URLSearchParams('view=other'))).toEqual({
      kind: 'message',
      id: 'm1',
      accountId: undefined,
    });
  });

  it('falls back to the bare mail path with nothing selected', () => {
    expect(buildMailPath({ mailboxId: null, emailId: null, threadId: null })).toBe('/mail');
    expect(parseMailPath([])).toBeNull();
  });

  it('percent-encodes ids that are not path-safe', () => {
    const path = buildMailPath({ mailboxId: null, emailId: 'a/b c?d', threadId: null });
    expect(path).toBe('/mail/message/a%2Fb%20c%3Fd');
    const segment = path.split('/').pop()!;
    expect(parseMailPath(['message', segment])).toEqual({
      kind: 'message',
      id: 'a/b c?d',
      accountId: undefined,
    });
  });

  it('survives a malformed percent-sequence instead of throwing', () => {
    expect(parseMailPath(['message', '%E0%A4%A'])).toEqual({
      kind: 'message',
      id: '%E0%A4%A',
      accountId: undefined,
    });
  });

  it('carries the account disambiguator', () => {
    const link = parseMailPath(['message', 'm1'], new URLSearchParams('account=acc-2'));
    expect(link).toEqual({ kind: 'message', id: 'm1', accountId: 'acc-2' });
  });

  it('still understands the legacy ?email= notification link', () => {
    expect(parseMailPath([], new URLSearchParams('email=m9'))).toEqual({
      kind: 'message',
      id: 'm9',
      accountId: undefined,
    });
  });

  it('ignores unknown segments rather than inventing an intent', () => {
    expect(parseMailPath(['nonsense', 'x'])).toBeNull();
    expect(parseMailPath(['message'])).toBeNull();
  });
});

describe('calendar paths', () => {
  it('formats and parses dates in local time', () => {
    const date = new Date(2026, 7, 6);
    expect(formatLinkDate(date)).toBe('2026-08-06');
    expect(parseLinkDate('2026-08-06')?.getTime()).toBe(date.getTime());
  });

  it('rejects malformed and impossible dates', () => {
    expect(parseLinkDate('2026-8-6')).toBeNull();
    expect(parseLinkDate('2026-02-31')).toBeNull();
    expect(parseLinkDate('nope')).toBeNull();
  });

  it('round-trips a view and date', () => {
    const path = buildCalendarPath({ view: 'day', date: new Date(2026, 7, 6) });
    expect(path).toBe('/calendar/day/2026-08-06');
    const link = parseCalendarPath(['day', '2026-08-06']);
    expect(link?.kind).toBe('view');
    expect(link).toMatchObject({ view: 'day' });
  });

  it('round-trips an event, with the account that owns it', () => {
    expect(buildCalendarPath({ view: 'month', date: null, eventId: 'e1' })).toBe('/calendar/event/e1');
    expect(buildCalendarPath({ view: 'month', date: null, eventId: 'e1', accountId: 'acc-2' }))
      .toBe('/calendar/event/e1?account=acc-2');
    expect(parseCalendarPath(['event', 'e1'], new URLSearchParams('account=acc-2')))
      .toEqual({ kind: 'event', id: 'e1', accountId: 'acc-2' });
  });

  it('accepts a bare date with no view', () => {
    expect(parseCalendarPath(['2026-08-06'])).toMatchObject({ kind: 'view', view: 'month' });
  });

  it('returns null for an unknown view', () => {
    expect(parseCalendarPath(['quarter'])).toBeNull();
    expect(parseCalendarPath([])).toBeNull();
  });
});

describe('contacts paths', () => {
  it('round-trips detail and edit links', () => {
    expect(buildContactsPath({ contactId: 'c1' })).toBe('/contacts/c1');
    expect(buildContactsPath({ contactId: 'c1', editing: true })).toBe('/contacts/c1/edit');
    expect(parseContactsPath(['c1'])).toEqual({ kind: 'contact', id: 'c1', edit: false, fromEmail: false });
    expect(parseContactsPath(['c1', 'edit'])).toEqual({ kind: 'contact', id: 'c1', edit: true, fromEmail: false });
  });

  it('keeps the legacy query form working', () => {
    expect(parseContactsPath([], new URLSearchParams('contactId=c1&view=edit&from=email')))
      .toEqual({ kind: 'contact', id: 'c1', edit: true, fromEmail: true });
    expect(parseContactsPath([], new URLSearchParams('addEmail=a%40b.c&addName=Ada')))
      .toEqual({ kind: 'create', email: 'a@b.c', name: 'Ada', fromEmail: false });
  });

  it('handles the create link', () => {
    expect(parseContactsPath(['new'], new URLSearchParams('email=a%40b.c')))
      .toEqual({ kind: 'create', email: 'a@b.c', name: undefined, fromEmail: false });
  });
});

describe('files paths', () => {
  it('round-trips a nested folder', () => {
    expect(buildFilesPath('/Documents/Invoices 2026')).toBe('/files/Documents/Invoices%202026');
    expect(parseFilesPath(['Documents', 'Invoices%202026'])).toEqual({
      path: '/Documents/Invoices 2026',
      preview: undefined,
    });
  });

  it('maps the drive root to the bare path', () => {
    expect(buildFilesPath('/')).toBe('/files');
    expect(parseFilesPath([])).toBeNull();
  });

  it('carries a file to preview', () => {
    expect(buildFilesPath('/Documents', 'report.pdf')).toBe('/files/Documents?preview=report.pdf');
    expect(parseFilesPath(['Documents'], new URLSearchParams('preview=report.pdf')))
      .toEqual({ path: '/Documents', preview: 'report.pdf' });
  });
});

describe('settings paths', () => {
  it('round-trips a tab', () => {
    expect(buildSettingsPath('appearance')).toBe('/settings/appearance');
    expect(buildSettingsPath(null)).toBe('/settings');
    expect(parseSettingsPath(['appearance'])).toBe('appearance');
    expect(parseSettingsPath([])).toBeNull();
  });
});

describe('matchSurface', () => {
  it('maps the app root and /mail to the mail surface', () => {
    expect(matchSurface('/')).toEqual({ surface: 'mail', segments: [] });
    expect(matchSurface('/mail')).toEqual({ surface: 'mail', segments: [] });
    expect(matchSurface('/mail/message/m1')).toEqual({ surface: 'mail', segments: ['message', 'm1'] });
  });

  it('ignores a leading locale segment', () => {
    expect(matchSurface('/de/calendar/day/2026-08-06'))
      .toEqual({ surface: 'calendar', segments: ['day', '2026-08-06'] });
    expect(matchSurface('/de')).toEqual({ surface: 'mail', segments: [] });
  });

  it('strips query and hash', () => {
    expect(matchSurface('/contacts/c1?from=email#x'))
      .toEqual({ surface: 'contacts', segments: ['c1'] });
  });

  it('returns null for routes that are not app surfaces', () => {
    expect(matchSurface('/pro')).toBeNull();
    expect(matchSurface('/login')).toBeNull();
  });
});
