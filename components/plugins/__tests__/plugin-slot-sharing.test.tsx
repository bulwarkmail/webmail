import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { PluginSlot, SHARED_FILL_MIN_HEIGHT } from '../plugin-slot';

let offers: Array<{ pluginId: string; fill?: boolean }> = [];
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => offers }));
vi.mock('../plugin-iframe-slot', () => ({
  PluginIframeSlot: ({ pluginId, minFillHeight }: { pluginId: string; minFillHeight?: number }) => (
    <div data-testid={pluginId} data-min={minFillHeight ?? ''} />
  ),
}));

describe('PluginSlot', () => {
  it('keeps a filling frame usable next to another frame in a short panel', () => {
    offers = [{ pluginId: 'notes' }, { pluginId: 'chat', fill: true }];
    render(<PluginSlot name="email-detail-sidebar" />);
    expect(screen.getByTestId('chat').dataset.min).toBe(String(SHARED_FILL_MIN_HEIGHT));
    expect(screen.getByTestId('notes').dataset.min).toBe('');
  });

  it('lets a filling frame alone in its panel take whatever height there is', () => {
    offers = [{ pluginId: 'chat', fill: true }];
    render(<PluginSlot name="email-detail-sidebar" />);
    expect(screen.getByTestId('chat').dataset.min).toBe('');
  });
});
