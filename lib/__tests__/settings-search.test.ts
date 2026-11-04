import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import {
  type SettingsSearchTab,
  descriptionKeyFor,
  getByPath,
  matchesAllWords,
  matchesSubResult,
  tabKeywords,
  settingsSubResults,
  tabSearchEntries,
  withAppName,
} from '../settings-search';

const labelsFor = (tab: SettingsSearchTab) => settingsSubResults(en, tab, 'Bulwark').map((r) => r.label);
const resultsFor = (tab: SettingsSearchTab, query: string) =>
  settingsSubResults(en, tab, 'Bulwark').filter((r) => matchesSubResult(r, query));

describe('settings search index (English messages)', () => {
  it('every entry names a label that exists, without a raw placeholder', () => {
    const broken: string[] = [];
    for (const entries of Object.values(tabSearchEntries)) {
      for (const entry of entries) {
        const label = getByPath(en, entry.label);
        if (typeof label !== 'string' || /\{(?!appName\})/.test(label)) broken.push(entry.label);
      }
    }
    expect(broken).toEqual([]);
  });

  it('finds a description next to its label', () => {
    expect(descriptionKeyFor('settings.email_behavior.send_delay.label', en)).toBe('settings.email_behavior.send_delay.description');
    expect(descriptionKeyFor('settings.contacts.group_by_letter_label', en)).toBe('settings.contacts.group_by_letter_description');
    expect(descriptionKeyFor('calendar.settings.calendar_free_scroll', en)).toBe('calendar.settings.calendar_free_scroll_desc');
  });

  it('lists each setting under the page that draws it', () => {
    expect(labelsFor('calendar')).toContain('Free scrolling');
    expect(labelsFor('calendar')).toContain('Show week numbers');
    expect(labelsFor('notifications')).toContain('Unread count on the tab and app icon');
    // settings-24 (2026-11-04): sender pictures, remote images and trusted
    // senders moved from Message list and Reading to the new Privacy page.
    expect(labelsFor('privacy')).toContain('Pictures from company websites');
    expect(labelsFor('message_list')).toContain('Clear search when switching folders');
    expect(labelsFor('privacy')).toContain('Trusted senders');
    expect(labelsFor('composing')).toContain('Undo send');
    expect(labelsFor('general')).toContain('Time zone');
    expect(labelsFor('organize')).toContain('Nested tags');
  });

  // SET-5: whole namespaces were indexed, so results led to pages without
  // the row (Sender Favicons under Backup & reset, Phone under Contacts,
  // Default Mail Program under Composing) or showed "Level {n} criterion".
  it('does not list settings a page does not draw', () => {
    expect(labelsFor('backup')).not.toContain('Sender favicons');
    expect(labelsFor('backup')).not.toContain('Keyboard shortcuts');
    expect(labelsFor('contacts')).not.toContain('Phone');
    expect(labelsFor('composing')).not.toContain('Default Mail Program');
    for (const tab of Object.keys(tabSearchEntries) as SettingsSearchTab[]) {
      expect(labelsFor(tab).filter((l) => l.includes('{'))).toEqual([]);
    }
  });

  // SET-6: these found nothing, or not the right row.
  it('finds the settings people searched for', () => {
    expect(resultsFor('message_list', 'inbox type').map((r) => r.label)).toEqual(['Inbox type']);
    expect(resultsFor('calendar', 'import calendar').map((r) => r.label)).toContain('Import calendar');
    expect(resultsFor('composing', 'mention').map((r) => r.label).slice(0, 2)).toEqual(['Mention recipients with @', 'Contacts in @ mentions']);
    expect(resultsFor('security', 'two-factor').map((r) => r.label)).toContain('Two-step sign-in');
    expect(resultsFor('filters', 'new rule').map((r) => r.label)).toEqual(['New rule']);
    // "add rule" finds the Filters page itself.
    expect(matchesAllWords(tabKeywords.filters, 'add rule')).toBe(true);
  });

  it('matches every word of a query, in any order', () => {
    const text = 'Signature Position Where to insert your signature in replies';
    expect(matchesAllWords(text, 'replies signature')).toBe(true);
    expect(matchesAllWords(text, 'signature replies')).toBe(true);
    expect(matchesAllWords(text, 'signature forwarding')).toBe(false);
    expect(resultsFor('composing', 'reply signature').map((r) => r.label)).toContain('Signature position');
  });

  it('finds the newer signature settings on their tabs', () => {
    expect(labelsFor('composing')).toContain('Signature on new mail');
    expect(labelsFor('composing')).toContain('Signature on replies & forwards');
    expect(labelsFor('composing')).toContain('Undo send');
  });

  it('marks the rows the Advanced switch hides', () => {
    const advanced = settingsSubResults(en, 'message_list', 'Bulwark').filter((r) => r.advanced).map((r) => r.label);
    expect(advanced).toContain('Emails per page');
    expect(settingsSubResults(en, 'privacy', 'Bulwark').filter((r) => r.advanced).map((r) => r.label)).not.toContain('Pictures from company websites');
  });
});

// settings-8 (2026-11-04): "offline", "autoreply" and "logout" found nothing,
// and "lock" found "Time format" (clock) and "Send Checks" (block).
describe('settings search: words, word starts and synonyms', () => {
  /** Every row of every page that the query finds, as "page: label". */
  const everywhere = (query: string) => (Object.keys(tabSearchEntries) as SettingsSearchTab[]).flatMap((tab) =>
    settingsSubResults(en, tab, 'Bulwark')
      .filter((r) => matchesSubResult(r, query))
      .map((r) => `${tab}: ${r.label}`));

  it('matches whole words and the start of words, not the inside of a word', () => {
    expect(matchesAllWords('App lock', 'lock')).toBe(true);
    expect(matchesAllWords('Clock format', 'lock')).toBe(false);
    expect(matchesAllWords('Block senders', 'lock')).toBe(false);
    expect(matchesAllWords('Notifications', 'notif')).toBe(true);
    expect(matchesAllWords('Two-factor authentication', 'two factor')).toBe(true);
    expect(matchesAllWords('Mention recipients', 'pin')).toBe(false);
  });

  it('still finds words inside Chinese, Japanese and Thai text, which has no spaces', () => {
    expect(matchesAllWords('自动回复设置', '回复')).toBe(true);
    expect(matchesAllWords('ตอบกลับอัตโนมัติ', 'อัตโนมัติ')).toBe(true);
  });

  it.each([
    ['offline', 'offline: Keep mail on this device'],
    ['autoreply', 'vacation: Reply automatically'],
    ['out of office', 'vacation: Reply automatically'],
    ['vacation', 'vacation: Reply automatically'],
    ['logout', 'account: Sign out'],
    ['sign out', 'account: Sign out'],
    ['2fa', 'security: Two-step sign-in'],
    ['two-factor', 'security: Two-step sign-in'],
    ['password', 'security: Change password'],
    ['signature', 'composing: Signatures'],
    ['font size', 'accessibility: Text size'],
    ['outbox', 'offline: Outbox'],
    ['s/mime', 'security: Encryption'],
  ])('finds "%s"', (query, row) => {
    expect(everywhere(query)).toContain(row);
  });

  it('finds the app lock for "pin", and nothing that only has "pin" inside a word', () => {
    expect(everywhere('pin')).toEqual(['general: Lock with a PIN']);
  });

  it('finds the Privacy page by its name and keywords', () => {
    expect(matchesAllWords(`Privacy ${tabKeywords.privacy}`, 'privacy')).toBe(true);
    expect(matchesAllWords(`Privacy ${tabKeywords.privacy}`, 'tracking')).toBe(true);
    expect(matchesAllWords(tabKeywords.reading, 'privacy')).toBe(false);
  });

  it('finds the app lock for "lock", not the clock or blocked senders', () => {
    const found = everywhere('lock');
    expect(found).toContain('general: App lock');
    // "12-hour or 24-hour clock" and "block" in their descriptions.
    expect(found).not.toContain('general: Time format');
    expect(found).not.toContain('privacy: Images & external content');
  });
});

// Decision 9 (2026-11-04): one setting, one place. Two rows called the same
// ("Notification sound" twice on Accessibility) made people change one and
// find the other "changed by itself".
describe('settings search: no two rows with the same name', () => {
  // Renamed on other branches of the same fix (settings-27 on the
  // notification sound and mail rows, the Default view rows of Calendar and
  // Files still to decide). Empty this list once they're merged.
  const PENDING_RENAMES = new Set<string>([]);

  it('names every indexed row and section differently, across all pages', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [tab, entries] of Object.entries(tabSearchEntries)) {
      for (const entry of entries) {
        const text = (withAppName(getByPath(en, entry.label), 'Bulwark') as string).trim().toLowerCase();
        if (PENDING_RENAMES.has(text)) continue;
        const where = `${tab}: ${entry.label}`;
        if (seen.has(text)) duplicates.push(`"${text}" at ${seen.get(text)} and ${where}`);
        else seen.set(text, where);
      }
    }
    expect(duplicates).toEqual([]);
  });
});

describe('{appName} in the index (#1314)', () => {
  it('fills in the configured name', () => {
    const results = settingsSubResults(en, 'general', 'Rath Mail');
    const text = results.map((r) => `${r.label} ${r.description ?? ''}`).join(' ');
    expect(text).not.toContain('{appName}');
    expect(text).toContain('Rath Mail');
  });

  it('leaves other values alone', () => {
    expect(withAppName({ a: 'x {appName} y', b: ['{appName}'], c: 3 }, 'N')).toEqual({ a: 'x N y', b: ['N'], c: 3 });
  });
});

// settings-p2-14 (2026-11-04): words people type that found nothing or the
// wrong row, and short words that matched a dozen descriptions.
describe('settings search: more words people use', () => {
  const everywhere = (query: string, shown?: (when: string | undefined) => boolean) =>
    (Object.keys(tabSearchEntries) as SettingsSearchTab[]).flatMap((tab) =>
      settingsSubResults(en, tab, 'Bulwark', (entry) => (shown ? shown(entry.when) : !entry.when?.startsWith('desktop')))
        .filter((r) => matchesSubResult(r, query))
        .map((r) => `${tab}: ${r.label}`));

  it.each([
    ['threads', 'message_list: Group messages by conversation'],
    // "Pictures from the internet" in the plain English the app shows.
    ['block images', 'privacy: External content'],
    ['dark mode', 'appearance: Light or dark'],
    ['timezone', 'general: Time zone'],
    ['reading pane', 'appearance: Mail layout'],
    ['week start', 'general: First day of week'],
    ['empty trash', 'message_list: Deleting & archiving'],
    // settings-p3-6: Do not disturb moved to Notifications as "Pause notifications".
    ['quiet hours', 'notifications: Pause notifications'],
  ])('finds "%s"', (query, row) => {
    expect(everywhere(query)).toContain(row);
  });

  it('looks for one short word in names and synonyms only, not in descriptions', () => {
    // "about" starts a word in many descriptions ("how you hear about new mail").
    expect(everywhere('about')).toEqual(['about: About Bulwark']);
    const row = { label: 'Sound', description: 'Plays a chime about new mail when it arrives' };
    expect(matchesSubResult(row, 'about')).toBe(false);
    expect(matchesSubResult(row, 'chime')).toBe(false);
    expect(matchesSubResult({ ...row, keywords: 'chime bell' }, 'chime')).toBe(true);
    // A longer word, or more words, still look in the description.
    expect(matchesSubResult(row, 'arrives')).toBe(true);
    expect(matchesSubResult(row, 'sound mail')).toBe(true);
    expect(matchesSubResult(row, 'sound tray')).toBe(false);
    // Chinese has no spaces: its words are looked for in descriptions too.
    expect(matchesSubResult({ label: '声音', description: '新邮件时播放提示音' }, '邮件')).toBe(true);
  });
});

// settings-p2-5 (2026-11-04): in the desktop app the app's own rows were
// missing from the search; "tray" found an unread count instead.
describe('settings search in the desktop app', () => {
  const inApp = (when: string | undefined, mac = false) => {
    if (when === 'browser') return false;
    if (when === 'desktopMac') return mac;
    if (when === 'desktopNotMac' || when === 'desktopMenuBar') return !mac;
    return when !== 'touch' && when !== 'mountainView' && when !== 'multiAccount';
  };
  const inAppResults = (query: string, mac = false) => (Object.keys(tabSearchEntries) as SettingsSearchTab[]).flatMap((tab) =>
    settingsSubResults(en, tab, 'Bulwark', (entry) => inApp(entry.when, mac))
      .filter((r) => matchesSubResult(r, query))
      .map((r) => `${tab}: ${r.label}`));
  const inBrowser = (query: string) => (Object.keys(tabSearchEntries) as SettingsSearchTab[]).flatMap((tab) =>
    settingsSubResults(en, tab, 'Bulwark', (entry) => !entry.when?.startsWith('desktop'))
      .filter((r) => matchesSubResult(r, query))
      .map((r) => `${tab}: ${r.label}`));

  it.each([
    ['tray', 'general: Keep running in the tray when closed'],
    ['quiet hours', 'notifications: Quiet hours'],
    ['do not disturb', 'notifications: Quiet hours'],
    ['autostart', 'general: Start when you sign in to your computer'],
    ['start with windows', 'general: Start when you sign in to your computer'],
    ['startup', 'general: Start when you sign in to your computer'],
    ['menu bar', 'general: Always show the menu bar'],
    ['taskbar', 'notifications: Flash the taskbar on new mail'],
    ['developer tools', 'general: Troubleshooting'],
    ['updates', 'general: Updates'],
    ['usage', 'privacy: Send usage info'],
    ['crash', 'privacy: Send crash reports'],
    ['default mail app', 'general: Default mail app'],
  ])('finds "%s"', (query, row) => {
    expect(inAppResults(query)).toContain(row);
  });

  it('lists "tray" first for the tray row, and the Dock row on a Mac', () => {
    expect(inAppResults('tray')[0]).toBe('general: Keep running in the tray when closed');
    expect(inAppResults('taskbar', true)).toContain('notifications: Bounce the Dock icon on new mail');
    expect(inAppResults('menu bar', true)).not.toContain('general: Always show the menu bar');
  });

  it('marks developer tools as an advanced row', () => {
    const devTools = settingsSubResults(en, 'general', 'Bulwark').find((r) => r.label === 'Troubleshooting');
    expect(devTools?.advanced).toBe(true);
  });

  it('keeps the app rows out of a browser, and the browser push rows out of the app', () => {
    expect(inBrowser('tray')).not.toContain('general: Keep running in the tray when closed');
    expect(inBrowser('quiet hours')).not.toContain('notifications: Quiet hours');
    expect(inAppResults('relay')).toEqual([]);
    expect(inBrowser('relay')).toContain('privacy: Relay for notifications');
  });
});
