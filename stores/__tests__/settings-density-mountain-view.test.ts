import { describe, it, expect } from 'vitest';
import { densityVarsFor, type Density, type InterfaceLayout } from '@/stores/settings-store';

// Mountain View has three row rhythms of its own and the app has four
// densities. The four are laid over its scale rather than left meaning
// whatever they meant in the default layout.

const px = (value: string) => Number.parseInt(value, 10);
const ROW = (density: Density, layout: InterfaceLayout) =>
  px(densityVarsFor(density, layout)['--list-item-height']);

describe('densityVarsFor', () => {
  it('lands the three shared names on the 32 / 40 / 48 pixel rows', () => {
    expect(ROW('compact', 'mountain-view')).toBe(32);
    expect(ROW('regular', 'mountain-view')).toBe(40);
    expect(ROW('comfortable', 'mountain-view')).toBe(48);
  });

  it('continues the series below compact rather than dropping a choice', () => {
    expect(ROW('extra-compact', 'mountain-view')).toBeLessThan(ROW('compact', 'mountain-view'));
  });

  it('keeps every step distinct, so all four settings still do something', () => {
    const heights = (['extra-compact', 'compact', 'regular', 'comfortable'] as Density[])
      .map((density) => ROW(density, 'mountain-view'));
    expect(new Set(heights).size).toBe(4);
    expect([...heights]).toEqual([...heights].sort((a, b) => a - b));
  });

  it('leaves the default layout exactly as it was', () => {
    expect(densityVarsFor('regular', 'default')['--list-item-height']).toBe('48px');
    expect(densityVarsFor('compact', 'default')['--list-item-height']).toBe('auto');
    expect(densityVarsFor('extra-compact', 'default')['--density-item-py']).toBe('2px');
  });

  it('restates only the vertical rhythm, not the rest of the spacing', () => {
    const mountainView = densityVarsFor('regular', 'mountain-view');
    const standard = densityVarsFor('regular', 'default');
    expect(mountainView['--density-card-p']).toBe(standard['--density-card-p']);
    expect(mountainView['--density-sidebar-py']).toBe(standard['--density-sidebar-py']);
    expect(mountainView['--density-item-py']).not.toBe(standard['--density-item-py']);
  });
});
