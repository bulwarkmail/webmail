import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
// PluginSlot reads active plugins from the sandbox registry and renders each
// inside a sandboxed iframe. Mock both so we can drive the offers and assert
// what PluginSlot renders without a real iframe + postMessage bridge.
const mockOffers: Record<string, Array<{ pluginId: string }>> = {};
// useSyncExternalStore requires a referentially stable snapshot; hand back a
// single shared empty array for unregistered slots instead of a fresh [].
const EMPTY_OFFERS: Array<{ pluginId: string }> = [];

vi.mock('@/lib/plugin-sandbox/registry', () => ({
  offersForSlot: (slot: string) => mockOffers[slot] ?? EMPTY_OFFERS,
  subscribe: () => () => {},
}));

vi.mock('@/components/plugins/plugin-iframe-slot', () => ({
  PluginIframeSlot: ({ pluginId, slot }: { pluginId: string; slot: string }) =>
    React.createElement('span', { 'data-iframe-plugin': pluginId }, `iframe:${slot}:${pluginId}`),
}));

// Import after mocks
import { PluginSlot } from '@/components/plugins/plugin-slot';
import { PluginErrorBoundary } from '@/components/plugins/plugin-error-boundary';

beforeEach(() => {
  Object.keys(mockOffers).forEach(k => delete mockOffers[k]);
});

describe('PluginSlot', () => {
  it('renders null when the slot has an empty offer list', () => {
    mockOffers['toolbar-actions'] = [];
    const { container } = render(
      React.createElement(PluginSlot, { name: 'toolbar-actions' })
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders null when the slot has no offers at all', () => {
    // slot entry doesn't exist in the registry
    const { container } = render(
      React.createElement(PluginSlot, { name: 'toolbar-actions' })
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders an iframe slot per offer', () => {
    mockOffers['email-footer'] = [{ pluginId: 'test' }];
    const { getByText } = render(
      React.createElement(PluginSlot, { name: 'email-footer' })
    );
    expect(getByText('iframe:email-footer:test')).toBeTruthy();
  });

  it('sets data-plugin-slot attribute', () => {
    mockOffers['sidebar-widget'] = [{ pluginId: 'sw' }];
    const { container } = render(
      React.createElement(PluginSlot, { name: 'sidebar-widget' })
    );
    expect(container.querySelector('[data-plugin-slot="sidebar-widget"]')).toBeTruthy();
  });
});

describe('PluginErrorBoundary', () => {
  it('renders children when no error', () => {
    const { getByText } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'test' },
        React.createElement('span', null, 'Child')
      )
    );
    expect(getByText('Child')).toBeTruthy();
  });

  it('renders fallback on error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingComponent = () => { throw new Error('boom'); };
    const { getByText } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'err', fallback: React.createElement('span', null, 'Error caught') },
        React.createElement(ThrowingComponent)
      )
    );
    expect(getByText('Error caught')).toBeTruthy();
    consoleSpy.mockRestore();
  });

  it('renders null on error when no fallback provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingComponent = () => { throw new Error('boom'); };
    const { container } = render(
      React.createElement(
        PluginErrorBoundary,
        { pluginId: 'err2' },
        React.createElement(ThrowingComponent)
      )
    );
    // ErrorBoundary renders null fallback
    expect(container.innerHTML).toBe('');
    consoleSpy.mockRestore();
  });
});
