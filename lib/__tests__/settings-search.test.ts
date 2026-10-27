import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import {
  type SettingsSearchTab,
  type SubResult,
  collectSubResults,
  flattenStrings,
  getByPath,
  tabSearchPaths,
  withAppName,
} from '../settings-search';

function subResultsFor(tab: SettingsSearchTab): SubResult[] {
  const list: SubResult[] = [];
  for (const path of tabSearchPaths[tab]) {
    collectSubResults(getByPath(en, path), list);
  }
  return list;
}

function haystackFor(tab: SettingsSearchTab): string {
  const strings: string[] = [];
  for (const path of tabSearchPaths[tab]) {
    flattenStrings(getByPath(en, path), strings);
  }
  return strings.join(' ').toLowerCase();
}

function labelsFor(tab: SettingsSearchTab): string[] {
  return subResultsFor(tab).map((r) => r.label);
}

describe('collectSubResults', () => {
  it('emits flat `key` / `key_desc` string pairs as a labelled sub-result', () => {
    const list: SubResult[] = [];
    collectSubResults(
      {
        title: 'Calendar settings',
        free_scroll: 'Free scrolling',
        free_scroll_desc: 'Scroll continuously',
        hover_preview_off: 'Disabled',
      },
      list
    );
    expect(list).toEqual([
      { label: 'Calendar settings', description: undefined },
      { label: 'Free scrolling', description: 'Scroll continuously' },
    ]);
  });

  it('still emits label/description objects and *_label keys', () => {
    const list: SubResult[] = [];
    collectSubResults(
      {
        name_label: 'Name',
        nested: { label: 'Theme', description: 'Pick one', dark: 'Dark' },
      },
      list
    );
    expect(list).toEqual([
      { label: 'Name' },
      { label: 'Theme', description: 'Pick one' },
    ]);
  });
});

describe('settings search index (English messages)', () => {
  it('every tab path resolves to a translation subtree', () => {
    const missing: string[] = [];
    for (const paths of Object.values(tabSearchPaths)) {
      for (const path of paths) {
        if (getByPath(en, path) === undefined) missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists the calendar toggles as sub-results', () => {
    const labels = labelsFor('calendar');
    expect(labels).toContain('Free scrolling');
    expect(labels).toContain('Show week numbers');
    expect(labels).toContain('Organize invitations as');
    expect(labels).toContain('Parse email invitations');
    expect(labelsFor('notifications')).toContain('Unread Count on Tab and App Icon');
    expect(labelsFor('notifications')).not.toContain('Parse email invitations');
    expect(labels).toContain('Contact birthday calendar');
    // Option values are not settings of their own.
    expect(labels).not.toContain('Disabled');
  });

  it('finds the newer mail settings on their tabs', () => {
    expect(labelsFor('message_list')).toContain('Clear search when switching folders');
    expect(labelsFor('message_list')).toContain('Swipe right action (mobile)');
    expect(labelsFor('message_list')).toContain('Message list order');
    expect(labelsFor('reading')).toContain('Trusted Senders');
    expect(labelsFor('reading')).toContain('Email (.eml) filename');
    expect(labelsFor('reading')).not.toContain('Delete Action');
    expect(labelsFor('composing')).toContain('Undo send / send delay');
    expect(labelsFor('composing')).toContain('Request read receipts by default');
    expect(labelsFor('composing')).toContain('Email Templates');
    expect(labelsFor('composing')).toContain('Quick Reply');
    expect(labelsFor('composing')).not.toContain('Sub-Address Delimiter');
    expect(labelsFor('appearance')).toContain('Pro Interface (Experimental)');
    expect(labelsFor('account')).toContain('Tell accounts apart');
    expect(labelsFor('account')).toContain('Your Identities');
    expect(labelsFor('appearance')).toContain('Themes');
    expect(labelsFor('general')).toContain('Time zone');
    expect(labelsFor('general')).toContain('Email links');
    expect(labelsFor('organize')).toContain('Nested Tags');
    expect(haystackFor('organize')).toContain('standard folder roles');
  });

  it('matches the calendar tab for a free-scroll query', () => {
    expect(haystackFor('calendar')).toContain('free scrolling');
    expect(haystackFor('general')).toContain('time zone');
  });
});

describe('{appName} in the index (#1314)', () => {
  const index = (appName: string) => {
    const list: SubResult[] = [];
    const strings: string[] = [];
    for (const path of tabSearchPaths.general) {
      const node = withAppName(getByPath(en, path), appName);
      collectSubResults(node, list);
      flattenStrings(node, strings);
    }
    return { list, haystack: strings.join(' ').toLowerCase() };
  };

  it('never keeps the raw placeholder', () => {
    for (const tab of Object.keys(tabSearchPaths) as SettingsSearchTab[]) {
      for (const path of tabSearchPaths[tab]) {
        expect(JSON.stringify(withAppName(getByPath(en, path), 'Bulwark')) ?? '').not.toContain('{appName}');
      }
    }
  });

  it('finds Default apps by "bulwark" on a stock install', () => {
    const { list, haystack } = index('Bulwark');
    expect(haystack).toContain('bulwark');
    expect(list.some((r) => r.description?.includes('Bulwark'))).toBe(true);
  });

  it('finds Default apps by the configured name', () => {
    const { list, haystack } = index('Rath Mail');
    expect(haystack).toContain('rath mail');
    const links: string[] = [];
    flattenStrings(withAppName(getByPath(en, 'protocol_handlers'), 'Rath Mail'), links);
    expect(links.join(' ').toLowerCase()).not.toContain('bulwark');
    expect(list.some((r) => r.description?.includes('Rath Mail'))).toBe(true);
  });

  it('leaves other values alone', () => {
    expect(withAppName({ a: 'x {appName} y', b: ['{appName}'], c: 3 }, 'N')).toEqual({ a: 'x N y', b: ['N'], c: 3 });
  });
});
