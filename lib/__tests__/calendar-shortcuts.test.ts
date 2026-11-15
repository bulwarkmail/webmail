import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import { CALENDAR_SECTIONS } from '@/lib/keyboard-shortcuts/calendar';
import { calendarShortcutAction } from '@/lib/calendar-shortcuts';

// The help modal lists Calendar's keys from CALENDAR_SECTIONS; the calendar
// page handles them through calendarShortcutAction. The two must agree.

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
}

const pressed = (key: string, code = '') => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });

describe('Calendar keyboard shortcuts', () => {
  it('lists Calendar keys in the help modal', () => {
    const rows = CALENDAR_SECTIONS.flatMap((s) => s.entries);
    expect(rows.length).toBeGreaterThan(5);
  });

  it('names every section and row with an existing string', () => {
    for (const section of CALENDAR_SECTIONS) {
      expect(typeof lookup(section.title), section.title).toBe('string');
      for (const entry of section.entries) expect(typeof lookup(entry.description), entry.description).toBe('string');
    }
  });

  it('handles every single letter it lists', () => {
    const views = CALENDAR_SECTIONS.find((s) => s.id === 'views')!;
    for (const { key } of views.entries) {
      expect(calendarShortcutAction(pressed(key, `Key${key.toUpperCase()}`)), key).not.toBeNull();
    }
    expect(calendarShortcutAction(pressed('t', 'KeyT'))).toBe('today');
    expect(calendarShortcutAction(pressed('n', 'KeyN'))).toBe('new');
    expect(calendarShortcutAction(pressed('/', 'Slash'))).toBe('search');
    // Shift + / is ?, the shell's help
    expect(calendarShortcutAction({ ...pressed('?', 'Slash'), shiftKey: true })).toBeNull();
  });

  it('ignores letters held with a modifier', () => {
    expect(calendarShortcutAction({ ...pressed('a', 'KeyA'), ctrlKey: true })).toBeNull();
    expect(calendarShortcutAction({ ...pressed('ArrowLeft'), altKey: true })).toBeNull();
  });
});

// MO-04: with single-key shortcuts off only the arrows are left.
describe('Calendar shortcuts with single keys off', () => {
  it('ignores letters and /', () => {
    expect(calendarShortcutAction(pressed('t', 'KeyT'), false)).toBeNull();
    expect(calendarShortcutAction(pressed('n', 'KeyN'), false)).toBeNull();
    expect(calendarShortcutAction(pressed('/', 'Slash'), false)).toBeNull();
  });

  it('keeps the arrows', () => {
    expect(calendarShortcutAction(pressed('ArrowLeft', 'ArrowLeft'), false)).toBe('prev');
    expect(calendarShortcutAction(pressed('ArrowRight', 'ArrowRight'), false)).toBe('next');
  });

  it('keeps letters by default', () => {
    expect(calendarShortcutAction(pressed('t', 'KeyT'))).toBe('today');
  });
});

// #1714: the letter the key types, and `/` however the layout types it.
describe('Calendar shortcuts on other layouts', () => {
  it('takes the typed letter', () => {
    // Colemak types t where a US keyboard has G, and g on its T.
    expect(calendarShortcutAction(pressed('t', 'KeyG'))).toBe('today');
    expect(calendarShortcutAction(pressed('g', 'KeyT'))).toBeNull();
  });

  it('keeps the US place on a non-Latin layout', () => {
    expect(calendarShortcutAction(pressed('е', 'KeyT'))).toBe('today');
  });

  it('opens the search with / typed with Shift (AZERTY)', () => {
    expect(calendarShortcutAction({ ...pressed('/', 'Period'), shiftKey: true })).toBe('search');
    expect(calendarShortcutAction(pressed('!', 'Slash'))).toBeNull();
  });
});
