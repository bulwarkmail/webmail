import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_AVATAR_COLORS,
  ACCOUNT_AVATAR_COUNT,
  ACCOUNT_AVATAR_DESIGNS,
  ACCOUNT_AVATAR_MOTIFS,
  pickAccountAvatar,
  renderAccountAvatar,
} from '@/lib/account-avatars';

describe('account avatar catalogue', () => {
  it('holds fifty designs that never repeat a shape and colour pairing', () => {
    expect(ACCOUNT_AVATAR_DESIGNS).toHaveLength(ACCOUNT_AVATAR_COUNT);
    const pairs = new Set(ACCOUNT_AVATAR_DESIGNS.map(d => `${d.motif}:${d.color}`));
    expect(pairs.size).toBe(ACCOUNT_AVATAR_COUNT);
  });

  it('draws on every colour and every shape', () => {
    expect(new Set(ACCOUNT_AVATAR_DESIGNS.map(d => d.color)).size).toBe(ACCOUNT_AVATAR_COLORS.length);
    expect(new Set(ACCOUNT_AVATAR_DESIGNS.map(d => d.motif)).size).toBe(ACCOUNT_AVATAR_MOTIFS.length);
  });

  it('only offers colours the row tint can render', () => {
    // accountTintKey maps these twelve onto named tints; anything else falls
    // back to a computed one, which is what made two accounts look alike.
    for (const color of ACCOUNT_AVATAR_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('pickAccountAvatar', () => {
  it('avoids the colours already on screen', () => {
    const used = ACCOUNT_AVATAR_COLORS.slice(0, 11);
    for (let i = 0; i < 20; i++) {
      expect(pickAccountAvatar(used).color).toBe(ACCOUNT_AVATAR_COLORS[11]);
    }
  });

  it('ignores case when comparing what is taken', () => {
    const used = ACCOUNT_AVATAR_COLORS.slice(0, 11).map(c => c.toUpperCase());
    expect(pickAccountAvatar(used).color).toBe(ACCOUNT_AVATAR_COLORS[11]);
  });

  it('still answers once every colour is spoken for', () => {
    const design = pickAccountAvatar([...ACCOUNT_AVATAR_COLORS], () => 0.999999);
    expect(ACCOUNT_AVATAR_DESIGNS).toContainEqual(design);
  });

  it('spreads across the catalogue rather than favouring one design', () => {
    const seen = new Set(Array.from({ length: 400 }, () => {
      const d = pickAccountAvatar();
      return `${d.motif}:${d.color}`;
    }));
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('renderAccountAvatar', () => {
  it('declines rather than throwing where there is no canvas to draw on', () => {
    // jsdom has no 2d context: an account simply keeps its initials.
    expect(renderAccountAvatar(ACCOUNT_AVATAR_DESIGNS[0]!)).toBeUndefined();
  });
});
