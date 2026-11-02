import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MvTopBarSkeleton } from '../shell';

// The Mountain View top bar as the pages draw it (components/layout/mv-top-bar.tsx).

describe('MvTopBarSkeleton', () => {
  it('starts with the sidebar toggle unless the page leaves it out, as contacts, files and plugin pages do', () => {
    const withMenu = render(<MvTopBarSkeleton />).container;
    expect(withMenu.querySelector('.tabler-icon-menu-2, .tabler-icon-menu')).not.toBeNull();

    const without = render(<MvTopBarSkeleton menu={false} />).container;
    expect(without.querySelector('.tabler-icon-menu-2, .tabler-icon-menu')).toBeNull();
    // MvTopBar showMenuButton={false} pads the brand instead.
    expect(without.firstElementChild?.firstElementChild).toHaveClass('ps-3');
  });

  it('ends with the account avatar, as the real bar does', () => {
    const bar = render(<MvTopBarSkeleton />).container.firstElementChild!;
    const cluster = bar.lastElementChild!;
    expect(cluster.lastElementChild?.querySelector('.rounded-full.w-8.h-8')).not.toBeNull();
  });
});
