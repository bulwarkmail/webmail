import { describe, it, expect } from 'vitest';
import { DEFAULT_DENSITY, MOUNTAIN_VIEW_DENSITY, densityShowsAttachmentChips, densityShowsAvatar, type Density } from '@/lib/density';

describe('densityShowsAvatar', () => {
  it.each([
    ['extra-compact', false],
    ['compact', true],
    ['regular', true],
    ['regular-no-avatars', false],
    ['comfortable', true],
  ] as [Density, boolean][])('%s -> %s', (density, shown) => {
    expect(densityShowsAvatar(density)).toBe(shown);
  });
});

describe('regular-no-avatars', () => {
  it('spaces rows exactly as regular in both layouts', () => {
    expect(DEFAULT_DENSITY['regular-no-avatars']).toEqual(DEFAULT_DENSITY.regular);
    expect(MOUNTAIN_VIEW_DENSITY['regular-no-avatars']).toEqual(MOUNTAIN_VIEW_DENSITY.regular);
  });

  it('keeps the attachment chips, as regular does', () => {
    expect(densityShowsAttachmentChips('regular-no-avatars')).toBe(true);
  });
});
