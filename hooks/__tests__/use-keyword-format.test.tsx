import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useKeywordFormat } from '../use-keyword-format';
import { useSettingsStore, KEYWORD_PALETTE, type KeywordDefinition } from '@/stores/settings-store';
import { suggestKeywordColor } from '@/lib/keyword-discovery';
import { CVD_CLASSES } from '@/lib/cvd-palette';

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
    it('draws tags in the colour-blind-safe palette while that setting is on', () => {
      useSettingsStore.setState({ colorBlindPalette: true });
      try {
        const { result } = renderHook(() => useKeywordFormat());
        // Blue and green, which red-green colour blindness can confuse, land on
        // the palette's blue and bluish green; the stored colours stay.
        expect(result.current.tagColor('work').dot).toBe('bg-[#0072B2]');
        expect(result.current.tagColor('work/clients').dot).toBe('bg-[#009E73]');
        expect(result.current.tagColor('archive').dot).toBe('bg-[#D55E00]');
        expect(useSettingsStore.getState().emailKeywords[0].color).toBe('blue');
      } finally {
        useSettingsStore.setState({ colorBlindPalette: false });
      }
    });

    it('resolves a tag to its palette entry, including the new shades', () => {
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('work')).toBe(KEYWORD_PALETTE.blue);
      expect(result.current.tagColor('archive')).toBe(KEYWORD_PALETTE['red-dark']);
    });

    it('gives a keyword it has no definition for a hue of its own', () => {
      // Set on the message by another client, applied by a server-side filter,
      // or its tag was deleted here. One shared grey made every such tag look
      // alike, which is when telling them apart matters most.
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('never-heard-of-it'))
        .toBe(KEYWORD_PALETTE[suggestKeywordColor('never-heard-of-it')]);
    });

    it('matches the colour the settings screen would propose for that tag', () => {
      // Adopting a discovered tag must not make its colour jump.
      const { result } = renderHook(() => useKeywordFormat());

      for (const id of ['netflix', 'humb', 'ebay']) {
        expect(result.current.tagColor(id)).toBe(KEYWORD_PALETTE[suggestKeywordColor(id)]);
      }
    });

    it('keeps an undefined tag on the same hue across renders', () => {
      const a = renderHook(() => useKeywordFormat());
      const b = renderHook(() => useKeywordFormat());

      expect(a.result.current.tagColor('humb')).toBe(b.result.current.tagColor('humb'));
    });

    it('spreads undefined tags over several hues', () => {
      const { result } = renderHook(() => useKeywordFormat());
      const ids = ['humb', 'alie', 'ebay', 'zoop', 'fire', 'nexu', 'ubis', 'tlsreports'];

      const dots = new Set(ids.map((id) => result.current.tagColor(id).dot));
      expect(dots.size).toBeGreaterThan(1);
    });

    it('derives a hue for a definition whose colour is not in the palette', () => {
      useSettingsStore.setState({ emailKeywords: [{ id: 'odd', label: 'Odd', color: 'chartreuse' }] });
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('odd')).toBe(KEYWORD_PALETTE[suggestKeywordColor('odd')]);
    });

    it('draws a custom #rrggbb through classes of its own, not the suggested colour', () => {
      useSettingsStore.setState({ emailKeywords: [{ id: 'odd', label: 'Odd', color: '#1a73e8' }] });
      const { result } = renderHook(() => useKeywordFormat());

      const color = result.current.tagColor('odd');
      expect(color).not.toBe(KEYWORD_PALETTE[suggestKeywordColor('odd')]);
      expect(color.dot).toBe('tag-hex-1a73e8-dot');
      expect(color.fill).toBe('tag-hex-1a73e8-fill');
      expect(color.rowTint).toBe('tag-hex-1a73e8-rowtint');
    });

    it('draws a custom #rrggbb in the nearest colour-blind-safe colour while that setting is on', () => {
      useSettingsStore.setState({ emailKeywords: [{ id: 'odd', label: 'Odd', color: '#1a73e8' }], colorBlindPalette: true });
      try {
        const { result } = renderHook(() => useKeywordFormat());
        expect(result.current.tagColor('odd')).toBe(CVD_CLASSES.blue);
        expect(useSettingsStore.getState().emailKeywords[0].color).toBe('#1a73e8');
      } finally {
        useSettingsStore.setState({ colorBlindPalette: false });
      }
    });

    it('treats a hex colour that is not lowercase #rrggbb as unknown', () => {
      useSettingsStore.setState({ emailKeywords: [{ id: 'odd', label: 'Odd', color: '#ABC' }] });
      const { result } = renderHook(() => useKeywordFormat());

      expect(result.current.tagColor('odd')).toBe(KEYWORD_PALETTE[suggestKeywordColor('odd')]);
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
