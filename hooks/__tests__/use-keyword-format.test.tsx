import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useKeywordFormat } from '../use-keyword-format';
import { useSettingsStore, KEYWORD_PALETTE, type KeywordDefinition } from '@/stores/settings-store';

const TAGS: KeywordDefinition[] = [
  { id: 'work', label: 'Work', color: 'blue' },
  { id: 'work/clients', label: 'Clients', color: 'green' },
  { id: 'archive', label: 'Archive', color: 'red-dark' },
];

describe('useKeywordFormat', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: TAGS, nestedTags: true });
  });

  describe('tagColor', () => {
    it('resolves a tag to its palette entry, including the new shades', () => {
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('work')).toBe(KEYWORD_PALETTE.blue);
      expect(result.current.tagColor('archive')).toBe(KEYWORD_PALETTE['red-dark']);
    });

    it('falls back to grey for a keyword this client has no definition for', () => {
      // Set on the message by another client, or its tag was deleted here.
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('never-heard-of-it')).toBe(KEYWORD_PALETTE.gray);
    });

    it('falls back to grey for a colour that is not in the palette', () => {
      useSettingsStore.setState({ emailKeywords: [{ id: 'odd', label: 'Odd', color: 'chartreuse' }] });
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('odd')).toBe(KEYWORD_PALETTE.gray);
    });
  });

  describe('sortTagIds', () => {
    it('follows the order the user arranged in settings', () => {
      // Settings order is work, work/clients, archive - drag-reorderable, and
      // deliberately not alphabetical.
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.sortTagIds(['archive', 'work/clients', 'work'])).toEqual([
        'work',
        'work/clients',
        'archive',
      ]);
    });

    it('is stable however the keywords happen to arrive', () => {
      const { result } = renderHook(() => useKeywordFormat());
      const expected = ['work', 'work/clients', 'archive'];

      expect(result.current.sortTagIds(['work', 'archive', 'work/clients'])).toEqual(expected);
      expect(result.current.sortTagIds(['archive', 'work', 'work/clients'])).toEqual(expected);
    });

    it('follows a reordering of the settings list', () => {
      useSettingsStore.setState({ emailKeywords: [TAGS[2], TAGS[0], TAGS[1]] });
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.sortTagIds(['work', 'archive'])).toEqual(['archive', 'work']);
    });

    it('puts a tag with no local definition last, ordered by name', () => {
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.sortTagIds(['zz-unknown', 'work', 'aa-unknown'])).toEqual([
        'work',
        'aa-unknown',
        'zz-unknown',
      ]);
    });

    it("leaves the caller's array alone", () => {
      const { result } = renderHook(() => useKeywordFormat());
      const input = ['archive', 'work'];

      result.current.sortTagIds(input);

      expect(input).toEqual(['archive', 'work']);
    });
  });
});
