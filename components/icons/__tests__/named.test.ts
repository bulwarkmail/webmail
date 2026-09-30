import { describe, it, expect } from 'vitest';
import { icons } from '@tabler/icons-react';
import {
  LEGACY_LUCIDE,
  POPULAR_ICON_NAMES,
  iconForName,
  toStoredIconName,
  toTablerName,
} from '../named';

const componentKey = (name: string) =>
  'Icon' + name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
const exists = (name: string) => componentKey(name) in icons;

describe('toTablerName', () => {
  it('reads the stored tabler: form', () => {
    expect(toTablerName('tabler:inbox')).toBe('inbox');
    expect(toTablerName(toStoredIconName('brand-github'))).toBe('brand-github');
  });

  it('translates Lucide names saved before the switch', () => {
    expect(toTablerName('Globe')).toBe('world');
    expect(toTablerName('Inbox')).toBe('inbox');
    expect(toTablerName('Trash2')).toBe('trash');
    expect(toTablerName('Gamepad2')).toBe('device-gamepad-2');
  });

  it('guesses unknown Lucide names by kebab-casing them', () => {
    expect(toTablerName('CloudRain')).toBe('cloud-rain');
    expect(toTablerName('Dice6')).toBe('dice-6');
  });

  it('accepts a bare Tabler name', () => {
    expect(toTablerName('world')).toBe('world');
    expect(toTablerName('a-b-2')).toBe('a-b-2');
  });

  it('rejects anything that is not a name', () => {
    expect(toTablerName('')).toBeNull();
    expect(toTablerName(null)).toBeNull();
    expect(toTablerName('tabler:../etc')).toBeNull();
    expect(toTablerName('Globe/../../x')).toBeNull();
  });
});

describe('icon tables', () => {
  it('maps every legacy Lucide name to an icon Tabler has', () => {
    const missing = Object.entries(LEGACY_LUCIDE).filter(([, t]) => !exists(t));
    expect(missing).toEqual([]);
  });

  it('only offers popular icons that exist', () => {
    expect(POPULAR_ICON_NAMES.filter((n) => !exists(n))).toEqual([]);
  });

  it('returns a component for any usable name and nothing for junk', () => {
    expect(iconForName('Globe')).toBe(icons.IconWorld);
    expect(iconForName('tabler:zzz')).toBeDefined();
    expect(iconForName('tabler:zzz')).toBe(iconForName('tabler:zzz'));
    expect(iconForName('')).toBeUndefined();
  });
});
