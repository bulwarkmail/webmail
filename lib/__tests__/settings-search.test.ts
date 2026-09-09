import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import {
  type SettingsSearchTab,
  type SubResult,
  collectSubResults,
  flattenStrings,
  getByPath,
  tabSearchPaths,
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
    expect(labels).toContain('Contact birthday calendar');
    // Option values are not settings of their own.
    expect(labels).not.toContain('Disabled');
  });

  it('finds the newer mail settings on their tabs', () => {
    expect(labelsFor('reading')).toContain('Clear search when switching folders');
    expect(labelsFor('reading')).toContain('Swipe right action (mobile)');
    expect(labelsFor('composing')).toContain('Undo send / send delay');
    expect(labelsFor('composing')).toContain('Request read receipts by default');
    expect(labelsFor('appearance')).toContain('Message list order');
    expect(labelsFor('layout')).toContain('Pro Interface (Experimental)');
    expect(labelsFor('language')).toContain('Time zone');
  });

  it('matches the calendar tab for a free-scroll query', () => {
    expect(haystackFor('calendar')).toContain('free scrolling');
    expect(haystackFor('language')).toContain('time zone');
  });
});
