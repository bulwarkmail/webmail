import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The density sample on Settings > Appearance draws the rows the way the
// list does: no preview line while Show preview is off.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn() }),
}));
vi.mock('../message-list-order-settings', () => ({ MessageListOrderSettings: () => null }));

const { AppearanceSettings } = await import('../appearance-settings');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');

const PREVIEW_TEXT = /Here are the latest numbers from/;

beforeEach(() => {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
});

describe('appearance settings density sample', () => {
  it('shows the preview line at Normal while Show preview is on', () => {
    useSettingsStore.setState({ density: 'regular', showPreview: true });
    const { queryByText } = render(<AppearanceSettings />);
    expect(queryByText(PREVIEW_TEXT)).not.toBeNull();
  });

  it('leaves the preview line out while Show preview is off', () => {
    useSettingsStore.setState({ density: 'regular', showPreview: false });
    const { getByText, queryByText } = render(<AppearanceSettings />);
    expect(getByText('Alice Johnson')).toBeInTheDocument();
    expect(queryByText(PREVIEW_TEXT)).toBeNull();
  });

  it('offers Normal without avatars between Normal and Comfortable', () => {
    useSettingsStore.setState({ density: 'regular', showPreview: true });
    const { container } = render(<AppearanceSettings />);
    const values = [...container.querySelectorAll('[data-option-value]')].map((b) => b.getAttribute('data-option-value'));
    expect(values).toContain('regular-no-avatars');
    expect(values.indexOf('regular-no-avatars')).toBe(values.indexOf('regular') + 1);
    expect(values.indexOf('comfortable')).toBe(values.indexOf('regular-no-avatars') + 1);
  });

  it('draws the sample without avatars but with the preview at Normal without avatars', () => {
    useSettingsStore.setState({ density: 'regular-no-avatars', showPreview: true });
    const { getByText, queryByText } = render(<AppearanceSettings />);
    expect(queryByText(PREVIEW_TEXT)).not.toBeNull();
    const sample = getByText('Alice Johnson').closest('.overflow-hidden')!;
    expect(sample.querySelector('.rounded-full.bg-muted')).toBeNull();
  });

  it('draws the sample avatars at Normal', () => {
    useSettingsStore.setState({ density: 'regular', showPreview: true });
    const { getByText } = render(<AppearanceSettings />);
    const sample = getByText('Alice Johnson').closest('.overflow-hidden')!;
    expect(sample.querySelectorAll('.rounded-full.bg-muted')).toHaveLength(3);
  });

  it('leaves it out at Compact even with Show preview on', () => {
    useSettingsStore.setState({ density: 'compact', showPreview: true });
    const { queryByText } = render(<AppearanceSettings />);
    expect(queryByText(PREVIEW_TEXT)).toBeNull();
  });
});
