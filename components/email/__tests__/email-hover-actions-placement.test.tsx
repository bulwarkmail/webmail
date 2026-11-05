import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { EmailHoverActions } from '../email-hover-actions';

vi.mock('@/components/plugins/plugin-actions', () => ({
  PluginActions: () => null,
  usePluginActions: () => [],
  useMessageActionTarget: () => ({ accountKind: 'personal', keywords: [] }),
  useRowActionTarget: (target: unknown) => target,
}));

// Gmail keeps a row's actions on its first line when attachment chips make the
// row taller; ours sat centred between the subject and the chips.

const email = { id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

function toolbar(pinToFirstLine?: boolean) {
  render(<EmailHoverActions email={email} onDelete={vi.fn()} pinToFirstLine={pinToFirstLine} />);
  return screen.getByTestId('hover-action-delete').closest('.absolute') as HTMLElement;
}

beforeEach(() => {
  useSettingsStore.setState({ hoverActions: ['delete'], interfaceLayout: 'mountain-view', hoverActionsMode: 'inline' } as never);
});

describe('row quick action placement', () => {
  it('stays on the first line of a Mountain View row', () => {
    const el = toolbar(true);
    expect(el.className).toContain('h-10');
    expect(el.className).not.toContain('bottom-0');
  });

  it('spans the whole row otherwise', () => {
    const el = toolbar();
    // Down to the row's outline, not over it (mail-p3-14).
    expect(el.style.bottom).toBe('var(--focus-ring-width, 2px)');
    expect(el.style.top).toBe('var(--focus-ring-width, 2px)');
    expect(el.getAttribute('style')).toMatch(/inset-inline-end: var\(--focus-ring-width, 2px\)/);
    expect(el.className).not.toContain('h-10');
  });
});

// Clicking a row focuses the row, so group-focus-within kept the actions on
// the open message after the pointer left it. Only keyboard focus on a control
// inside the row may show them.
describe('row quick action visibility', () => {
  it.each(['inline', 'floating'])('shows the %s actions on hover and keyboard focus only', (mode) => {
    useSettingsStore.setState({ hoverActionsMode: mode } as never);
    const classes = toolbar().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['hidden', 'group-hover:flex', 'group-has-[:focus-visible]:flex']));
    expect(classes).not.toContain('group-focus-within:flex');
  });
});
