import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'en' }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: false }) }));

import { PluginsSettings } from '../plugins-settings';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import type { InstalledPlugin } from '@/lib/plugin-types';

const plugin = (overrides: Partial<InstalledPlugin>) => ({
  id: 'send-checks', name: 'Send Checks', version: '1.0.0', author: 'Bulwark',
  description: 'Checks for IBAN and card numbers before a message is sent.',
  type: 'hook', permissions: [], entrypoint: 'index.js', enabled: false, status: 'installed', managed: true, settings: {},
  ...overrides,
}) as InstalledPlugin;

function show(plugins: InstalledPlugin[]) {
  usePolicyStore.setState({ loaded: true, isFeatureEnabled: () => true, isPluginForceEnabled: () => false } as never);
  usePluginStore.setState({ plugins, initialized: true, initializePlugins: vi.fn() } as never);
  render(<PluginsSettings />);
}

describe('a plugin in the user\'s list', () => {
  it('says what it does without opening it', () => {
    show([plugin({})]);
    expect(screen.getByTestId('plugin-description')).toHaveTextContent('Checks for IBAN and card numbers before a message is sent.');
  });

  it('has no "Off" or "On" word next to its switch', () => {
    show([plugin({}), plugin({ id: 'b', name: 'B', enabled: true, status: 'running' })]);
    expect(screen.queryByText('status_installed')).toBeNull();
    expect(screen.queryByText('status_running')).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('still says when something is wrong', () => {
    show([plugin({ status: 'error', error: 'auto-disabled' })]);
    expect(screen.getByText('status_error')).toBeInTheDocument();
  });
});
