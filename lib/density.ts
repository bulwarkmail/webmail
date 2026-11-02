/**
 * The CSS custom properties each list density writes on <html>.
 *
 * Shared by the settings store, which applies them when JS runs, and by the
 * boot script in app/(main)/layout.tsx, which applies the same values before
 * the first paint so the skeleton and the loaded page share one row rhythm.
 */

export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
export type InterfaceLayout = 'default' | 'mountain-view';

export type DensityVars = Record<string, string>;

export const DEFAULT_DENSITY: Record<Density, DensityVars> = {
  'extra-compact': {
    '--list-item-height': 'auto',
    '--density-item-py': '2px',
    '--density-item-gap': '6px',
    '--density-header-py': '4px',
    '--density-card-p': '8px',
    '--density-sidebar-py': '0px',
  },
  compact: {
    '--list-item-height': 'auto',
    '--density-item-py': '4px',
    '--density-item-gap': '8px',
    '--density-header-py': '6px',
    '--density-card-p': '10px',
    '--density-sidebar-py': '1px',
  },
  regular: {
    '--list-item-height': '48px',
    '--density-item-py': '12px',
    '--density-item-gap': '12px',
    '--density-header-py': '12px',
    '--density-card-p': '16px',
    '--density-sidebar-py': '4px',
  },
  comfortable: {
    '--list-item-height': '64px',
    '--density-item-py': '16px',
    '--density-item-gap': '16px',
    '--density-header-py': '16px',
    '--density-card-p': '20px',
    '--density-sidebar-py': '6px',
  },
};

/**
 * Mountain View's rows come in three rhythms - 32, 40 and 48 pixels - and the
 * app offers four densities. The four are laid over that scale: `compact`,
 * `regular` and `comfortable` land on the three exactly, and `extra-compact`
 * continues the series a step below, so every density still does something.
 *
 * Only the vertical rhythm is restated. Everything else a density touches -
 * gaps, card padding, the sidebar's own row padding - keeps its default value;
 * a navigation row is already pinned to 32px by the layout's own token.
 */
export const MOUNTAIN_VIEW_DENSITY: Record<Density, DensityVars> = {
  'extra-compact': { ...DEFAULT_DENSITY['extra-compact'], '--list-item-height': '28px', '--density-item-py': '4px' },
  compact: { ...DEFAULT_DENSITY.compact, '--list-item-height': '32px', '--density-item-py': '6px' },
  regular: { ...DEFAULT_DENSITY.regular, '--list-item-height': '40px', '--density-item-py': '10px' },
  comfortable: { ...DEFAULT_DENSITY.comfortable, '--list-item-height': '48px', '--density-item-py': '14px' },
};

export function densityVarsFor(density: Density, layout: InterfaceLayout): DensityVars {
  return (layout === 'mountain-view' ? MOUNTAIN_VIEW_DENSITY : DEFAULT_DENSITY)[density];
}
