import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings > Appearance > Layout: Interface layout and Mail layout each draw
// a small screen of the option under the pointer or focus, the selected one
// otherwise, and each drawing carries the other setting's current choice.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));

const { LayoutSection } = await import('../layout-settings');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');

const MV_LABEL = 'settings.appearance.interface_layout.mountain_view';
const DEFAULT_LABEL = 'settings.appearance.interface_layout.default';

beforeEach(() => {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
  useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'split' });
});

function setup() {
  const view = render(<LayoutSection />);
  const preview = (id: string) => view.getByTestId(id);
  const drawing = (id: string) => preview(id).querySelector('[data-shell]') as HTMLElement;
  return { ...view, preview, drawing };
}

describe('interface layout preview', () => {
  it('draws a preview for each option', () => {
    const { getByRole, preview, drawing } = setup();
    const card = () => preview('interface-layout-preview');

    fireEvent.pointerOver(getByRole('button', { name: MV_LABEL }));
    expect(card().dataset.option).toBe('mountain-view');
    expect(card()).toHaveTextContent('layout_preview.mountain_view_description');
    expect(drawing('interface-layout-preview').dataset.shell).toBe('mountain-view');
    // Mountain View always opens a conversation in place of the list.
    expect(drawing('interface-layout-preview').dataset.mail).toBe('focus');

    fireEvent.pointerOver(getByRole('button', { name: DEFAULT_LABEL }));
    expect(card().dataset.option).toBe('default');
    expect(card()).toHaveTextContent('layout_preview.default_description');
    const shell = drawing('interface-layout-preview');
    expect(shell.dataset.shell).toBe('default');
    expect(shell.querySelector('[data-part="apps"]')).not.toBeNull();
    expect(shell.querySelector('[data-part="folders"]')).not.toBeNull();
    expect(shell.querySelector('[data-part="search"]')).not.toBeNull();
  });

  it('shows the hovered option and goes back to the selected one on leave', () => {
    const { getByRole, preview } = setup();
    const card = () => preview('interface-layout-preview');
    expect(card().dataset.option).toBe('default');

    const mv = getByRole('button', { name: MV_LABEL });
    fireEvent.pointerOver(mv);
    expect(card().dataset.option).toBe('mountain-view');
    // Comparing doesn't talk: screen readers keep the selected option.
    expect(preview('interface-layout-preview-status')).toHaveTextContent(DEFAULT_LABEL);

    fireEvent.pointerLeave(mv.closest('[role="group"]')!.parentElement!);
    expect(card().dataset.option).toBe('default');
  });

  it('shows the focused option and goes back to the selected one on blur', () => {
    const { getByRole, preview } = setup();
    const card = () => preview('interface-layout-preview');
    const mv = getByRole('button', { name: MV_LABEL });

    act(() => mv.focus());
    expect(card().dataset.option).toBe('mountain-view');
    act(() => mv.blur());
    expect(card().dataset.option).toBe('default');
  });

  it('says the new title once an option is chosen', () => {
    const { getByRole, preview } = setup();
    fireEvent.click(getByRole('button', { name: MV_LABEL }));
    expect(useSettingsStore.getState().interfaceLayout).toBe('mountain-view');
    expect(preview('interface-layout-preview-status')).toHaveTextContent(MV_LABEL);
  });

  it('draws the default layout with the saved mail layout', () => {
    useSettingsStore.setState({ mailLayout: 'horizontal' });
    const { drawing } = setup();
    expect(drawing('interface-layout-preview').dataset.mail).toBe('horizontal');
  });
});

describe('mail layout preview', () => {
  it('follows the hovered mail layout and restores the selected one', () => {
    const { getByRole, preview } = setup();
    const card = () => preview('mail-layout-preview');
    expect(card().dataset.option).toBe('split');

    const focus = getByRole('button', { name: 'settings.email_behavior.mail_layout.focus' });
    fireEvent.pointerOver(focus);
    expect(card().dataset.option).toBe('focus');
    expect(card()).toHaveTextContent('settings.email_behavior.mail_layout.focus_description');
    expect(preview('mail-layout-preview-status')).toHaveTextContent('settings.email_behavior.mail_layout.split');

    fireEvent.pointerLeave(focus.closest('[role="group"]')!.parentElement!);
    expect(card().dataset.option).toBe('split');
  });

  it('draws the shell of the interface layout in use', () => {
    const { drawing } = setup();
    const shell = drawing('mail-layout-preview');
    expect(shell.dataset.shell).toBe('default');
    // The default layout's app rail and folder sidebar, around the list.
    expect(shell.querySelector('[data-part="apps"]')).not.toBeNull();
    expect(shell.querySelector('[data-part="folders"]')).not.toBeNull();
    expect(shell.dataset.mail).toBe('split');
  });
});
