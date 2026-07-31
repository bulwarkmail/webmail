import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, DEFAULT_KEYWORDS, DEV_KEYWORDS, KEYWORD_PALETTE, KEYWORD_PALETTE_ROWS, getKeywordVisibility } from '../settings-store';
import type { KeywordDefinition } from '../settings-store';

describe('settings-store keywords', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS] });
  });

  describe('DEFAULT_KEYWORDS', () => {
    it('has 7 default keywords', () => {
      expect(DEFAULT_KEYWORDS).toHaveLength(7);
    });

    it('each default keyword has a valid palette color', () => {
      DEFAULT_KEYWORDS.forEach((kw) => {
        expect(KEYWORD_PALETTE[kw.color]).toBeDefined();
        expect(KEYWORD_PALETTE[kw.color].dot).toBeTruthy();
        expect(KEYWORD_PALETTE[kw.color].fill).toBeTruthy();
      });
    });

    it('all default keyword ids are unique', () => {
      const ids = DEFAULT_KEYWORDS.map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('ships no nested tag, which is opt-in', () => {
      DEFAULT_KEYWORDS.forEach((kw) => expect(kw.id).not.toContain('/'));
    });
  });

  describe('DEV_KEYWORDS', () => {
    it('every nested tag has its parent defined, so the tree has no gaps', () => {
      const ids = new Set(DEV_KEYWORDS.map((k) => k.id));
      DEV_KEYWORDS.forEach((kw) => {
        const cut = kw.id.lastIndexOf('/');
        if (cut > 0) expect(ids, `orphan: ${kw.id}`).toContain(kw.id.slice(0, cut));
      });
    });

    it('nests deeply enough to exercise the tree', () => {
      const depths = DEV_KEYWORDS.map((k) => k.id.split('/').length);
      expect(Math.max(...depths)).toBeGreaterThanOrEqual(3);
    });

    it('each dev keyword has a valid palette color and a unique id', () => {
      const ids = DEV_KEYWORDS.map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
      DEV_KEYWORDS.forEach((kw) => expect(KEYWORD_PALETTE[kw.color]).toBeDefined());
    });
  });

  describe('KEYWORD_PALETTE', () => {
    it('has a lighter, base and darker shade of every hue', () => {
      expect(KEYWORD_PALETTE_ROWS).toHaveLength(3);
      KEYWORD_PALETTE_ROWS.forEach((row) => expect(row).toHaveLength(13));
      expect(Object.keys(KEYWORD_PALETTE)).toHaveLength(39);
    });

    it('lays every row out in the same hue order', () => {
      const [light, base, dark] = KEYWORD_PALETTE_ROWS;
      expect(light).toEqual(base.map((key) => `${key}-light`));
      expect(dark).toEqual(base.map((key) => `${key}-dark`));
    });

    it('keeps the bare hue name on the base row, so saved tags still resolve', () => {
      // A tag stored as `red` predates the lighter and darker rows.
      expect(KEYWORD_PALETTE_ROWS[1]).toContain('red');
      expect(KEYWORD_PALETTE.red).toBeDefined();
    });

    it('spells every class out so Tailwind can find it', () => {
      // A composed class name would compile to nothing, so none may be built
      // at runtime and each has to carry its own utility prefix.
      Object.values(KEYWORD_PALETTE).forEach((entry) => {
        expect(entry.dot).toMatch(/^bg-/);
        expect(entry.fill).toMatch(/^bg-/);
        expect(entry.border).toMatch(/^border-/);
        expect(entry.text).toMatch(/^text-.* dark:text-/);
        expect(entry.rowTint).toMatch(/^bg-.* dark:bg-/);
      });
    });

    it('resolves every row key', () => {
      KEYWORD_PALETTE_ROWS.flat().forEach((key) => {
        expect(KEYWORD_PALETTE[key]).toBeDefined();
      });
    });
  });

  describe('addKeyword', () => {
    it('adds a new keyword to the list', () => {
      const newKw: KeywordDefinition = { id: 'custom', label: 'Custom', color: 'teal' };
      useSettingsStore.getState().addKeyword(newKw);
      const keywords = useSettingsStore.getState().emailKeywords;
      expect(keywords).toHaveLength(DEFAULT_KEYWORDS.length + 1);
      expect(keywords[keywords.length - 1]).toEqual(newKw);
    });

    it('does not add duplicate keyword id', () => {
      const duplicate: KeywordDefinition = { id: 'red', label: 'Another Red', color: 'red' };
      useSettingsStore.getState().addKeyword(duplicate);
      expect(useSettingsStore.getState().emailKeywords).toHaveLength(DEFAULT_KEYWORDS.length);
    });

    it('allows adding keyword after removing one with same id', () => {
      useSettingsStore.getState().removeKeyword('red');
      const newRed: KeywordDefinition = { id: 'red', label: 'New Red', color: 'red' };
      useSettingsStore.getState().addKeyword(newRed);
      const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red');
      expect(kw?.label).toBe('New Red');
    });
  });

  describe('updateKeyword', () => {
    it('updates label of existing keyword', () => {
      useSettingsStore.getState().updateKeyword('red', { label: 'Crimson' });
      const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red');
      expect(kw?.label).toBe('Crimson');
      expect(kw?.color).toBe('red'); // color unchanged
    });

    it('updates color of existing keyword', () => {
      useSettingsStore.getState().updateKeyword('blue', { color: 'cyan' });
      const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'blue');
      expect(kw?.color).toBe('cyan');
      expect(kw?.label).toBe('Blue'); // label unchanged
    });

    it('updates both label and color', () => {
      useSettingsStore.getState().updateKeyword('green', { label: 'Emerald', color: 'teal' });
      const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'green');
      expect(kw?.label).toBe('Emerald');
      expect(kw?.color).toBe('teal');
    });

    it('does not affect other keywords', () => {
      useSettingsStore.getState().updateKeyword('red', { label: 'Crimson' });
      const blue = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'blue');
      expect(blue?.label).toBe('Blue');
    });

    it('is a no-op for non-existent id', () => {
      const before = useSettingsStore.getState().emailKeywords;
      useSettingsStore.getState().updateKeyword('nonexistent', { label: 'Test' });
      const after = useSettingsStore.getState().emailKeywords;
      expect(after).toHaveLength(before.length);
    });
  });

  describe('removeKeyword', () => {
    it('removes a keyword by id', () => {
      useSettingsStore.getState().removeKeyword('red');
      const keywords = useSettingsStore.getState().emailKeywords;
      expect(keywords).toHaveLength(DEFAULT_KEYWORDS.length - 1);
      expect(keywords.find((k) => k.id === 'red')).toBeUndefined();
    });

    it('is a no-op for non-existent id', () => {
      useSettingsStore.getState().removeKeyword('nonexistent');
      expect(useSettingsStore.getState().emailKeywords).toHaveLength(DEFAULT_KEYWORDS.length);
    });

    it('preserves order of remaining keywords', () => {
      useSettingsStore.getState().removeKeyword('green');
      const ids = useSettingsStore.getState().emailKeywords.map((k) => k.id);
      expect(ids).toEqual(['red', 'orange', 'yellow', 'blue', 'purple', 'pink']);
    });
  });

  describe('reorderKeywords', () => {
    it('replaces keyword list with new ordering', () => {
      const reversed = [...DEFAULT_KEYWORDS].reverse();
      useSettingsStore.getState().reorderKeywords(reversed);
      const ids = useSettingsStore.getState().emailKeywords.map((k) => k.id);
      expect(ids).toEqual(reversed.map((k) => k.id));
    });

    it('can set to empty list', () => {
      useSettingsStore.getState().reorderKeywords([]);
      expect(useSettingsStore.getState().emailKeywords).toHaveLength(0);
    });

    it('can reset to defaults', () => {
      useSettingsStore.getState().removeKeyword('red');
      useSettingsStore.getState().removeKeyword('blue');
      useSettingsStore.getState().reorderKeywords(DEFAULT_KEYWORDS);
      expect(useSettingsStore.getState().emailKeywords).toEqual(DEFAULT_KEYWORDS);
    });
  });

  describe('getKeywordById', () => {
    it('finds keyword by id', () => {
      const kw = useSettingsStore.getState().getKeywordById('blue');
      expect(kw).toEqual({ id: 'blue', label: 'Blue', color: 'blue' });
    });

    it('returns undefined for non-existent id', () => {
      expect(useSettingsStore.getState().getKeywordById('nonexistent')).toBeUndefined();
    });

    it('returns updated keyword data after updateKeyword', () => {
      useSettingsStore.getState().updateKeyword('red', { label: 'Scarlet' });
      const kw = useSettingsStore.getState().getKeywordById('red');
      expect(kw?.label).toBe('Scarlet');
    });
  });

  describe('getKeywordVisibility', () => {
    it('treats a tag stored before visibility was configurable as always shown', () => {
      expect(getKeywordVisibility({ id: 'red', label: 'Red', color: 'red' })).toBe('show');
    });

    it('returns the stored choice when there is one', () => {
      expect(getKeywordVisibility({ id: 'red', label: 'Red', color: 'red', visibility: 'unread' })).toBe('unread');
      expect(getKeywordVisibility({ id: 'red', label: 'Red', color: 'red', visibility: 'hide' })).toBe('hide');
    });
  });

  describe('nestedTags', () => {
    it('is off by default', () => {
      useSettingsStore.getState().resetToDefaults();
      expect(useSettingsStore.getState().nestedTags).toBe(false);
    });

    it('is included in exported settings', () => {
      useSettingsStore.getState().updateSetting('nestedTags', true);
      const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as {
        nestedTags?: boolean;
      };
      expect(exported.nestedTags).toBe(true);
    });
  });
});
