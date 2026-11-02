import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import {
  type SettingsSearchTab,
  descriptionKeyFor,
  getByPath,
  matchesAllWords,
  tabKeywords,
  settingsSubResults,
  tabSearchEntries,
  withAppName,
} from '../settings-search';

const labelsFor = (tab: SettingsSearchTab) => settingsSubResults(en, tab, 'Bulwark').map((r) => r.label);
const resultsFor = (tab: SettingsSearchTab, query: string) =>
  settingsSubResults(en, tab, 'Bulwark').filter((r) => matchesAllWords(`${r.label} ${r.description ?? ''}`, query));

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
    expect(labelsFor('message_list')).toContain('Sender favicons');
    expect(labelsFor('message_list')).toContain('Clear search when switching folders');
    expect(labelsFor('reading')).toContain('Trusted senders');
    expect(labelsFor('composing')).toContain('Undo send / send delay');
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
    expect(resultsFor('security', 'two-factor').map((r) => r.label)).toContain('Two-factor authentication');
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
    expect(labelsFor('composing')).toContain('Undo send / send delay');
  });

  it('marks the rows the Advanced switch hides', () => {
    const advanced = settingsSubResults(en, 'message_list', 'Bulwark').filter((r) => r.advanced).map((r) => r.label);
    expect(advanced).toContain('Emails per page');
    expect(advanced).not.toContain('Sender favicons');
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
