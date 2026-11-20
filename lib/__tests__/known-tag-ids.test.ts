import { afterEach, describe, expect, it } from 'vitest';
import { collectTagIds, knownTagIds } from '../known-tag-ids';
import { buildJMAPFilter, DEFAULT_SEARCH_FILTERS } from '../jmap/search-utils';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';
import { resetSharedTags, useSharedTagsStore, type SharedTagsEntry } from '@/stores/shared-tags-store';

const tag = (id: string, extra: Partial<KeywordDefinition> = {}): KeywordDefinition => ({ id, label: id, color: 'blue', ...extra });

const sharedEntry = (tags: KeywordDefinition[]): SharedTagsEntry => ({
  status: 'ready', tags, stored: null, pending: [], discovered: {}, loadedAt: 1, discoveredAt: 1, readFailedAt: null,
});

describe('collectTagIds', () => {
  it('takes the user’s tags, then the shared ones, once each regardless of case', () => {
    expect(collectTagIds(
      [tag('work'), tag('Red')],
      {
        'login|group-a': { tags: [tag('red'), tag('team')] },
        'login|group-b': { tags: [tag('TEAM'), tag('billing')] },
      },
    )).toEqual(['work', 'Red', 'team', 'billing']);
  });

  it('counts hidden tags too', () => {
    expect(collectTagIds([tag('archive', { visibility: 'hide' })], {})).toEqual(['archive']);
  });

  it('is empty without definitions', () => {
    expect(collectTagIds([], {})).toEqual([]);
  });
});

describe('knownTagIds', () => {
  const personal = useSettingsStore.getState().emailKeywords;

  afterEach(() => {
    useSettingsStore.setState({ emailKeywords: personal });
    resetSharedTags();
  });

  it('reads the settings and the loaded shared tags, so the No tags filter leaves them all out', () => {
    useSettingsStore.setState({ emailKeywords: [tag('work')] });
    useSharedTagsStore.setState({ entries: { 'login|group': sharedEntry([tag('Work'), tag('team')]) } });

    const ids = knownTagIds();
    expect(ids).toEqual(['work', 'team']);
    expect(buildJMAPFilter('', { ...DEFAULT_SEARCH_FILTERS, untagged: true }, undefined, ids)).toEqual({
      operator: 'AND',
      conditions: [
        { notKeyword: '$label:work' }, { notKeyword: '$color:work' },
        { notKeyword: '$label:team' }, { notKeyword: '$color:team' },
      ],
    });
  });
});
