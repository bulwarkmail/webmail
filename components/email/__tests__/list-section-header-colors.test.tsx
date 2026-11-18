import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ListDateGroupHeader } from '../list-date-group-header';
import { MvListSectionHeader } from '../mv-list-section-header';

// The message list's section headers (date groups, Pinned, Mountain View's
// Unread / Everything else) sit on their own band in the theme's
// --color-list-section, with --color-list-section-foreground text.

describe('list section header colors', () => {
  it('draws a date header on the list section band', () => {
    const { container } = render(<ListDateGroupHeader title="Today" collapsed={false} onToggle={vi.fn()} />);
    const row = container.querySelector('[data-list-date-group]')!;
    const button = row.querySelector('button')!;
    expect(row.className).toContain('bg-list-section');
    expect(row.className).toContain('h-9');
    expect(button.className).toContain('text-list-section-foreground');
    expect(button.className).not.toContain('text-muted-foreground');
    expect(button.className).toContain('hover:bg-[color-mix(in_srgb,var(--color-list-section-foreground)_10%,var(--color-list-section))]');
  });

  it("draws Mountain View's section header on the list section band", () => {
    const { container } = render(<MvListSectionHeader title="Unread" collapsed={false} onToggle={vi.fn()} shown={3} total={3} />);
    const row = container.querySelector('[data-mv-list-section]')!;
    const button = row.querySelector('button')!;
    expect(row.className).toContain('bg-list-section');
    expect(row.className).toContain('h-12');
    expect(button.className).toContain('text-list-section-foreground');
    expect(row.querySelector('svg')!.getAttribute('class')).not.toContain('text-muted-foreground');
    expect(row.querySelector('.tabular-nums')!.className).toContain('text-list-section-foreground');
  });
});
