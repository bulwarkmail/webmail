import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Devices > No notification prompt (#1902): devices.noNotificationPrompt per scope.

const puts: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      stored = body;
      return new Response('{"ok":true}');
    }
    return new Response(JSON.stringify(stored));
  }),
  withBasePath: (p: string) => p,
  getPathPrefix: () => '',
}));

import { DevicesSection } from '../sections/devices-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'field', label: 'Field staff', match: { groups: ['field@example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <DevicesSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-devices-noNotificationPrompt')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Devices section: notification prompt', () => {
  it('is off by default and saves devices.noNotificationPrompt', async () => {
    await renderSection();
    expect(screen.getByText('No notification prompt')).toBeInTheDocument();
    const toggle = screen.getByTestId('org-devices-noNotificationPrompt');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { devices: { noNotificationPrompt: boolean } }).devices.noNotificationPrompt).toBe(true);
  });

  it('writes a group override only into that scope', async () => {
    await renderSection();
    act(() => latest!.setScopeId('field'));
    fireEvent.click(screen.getByTestId('org-devices-noNotificationPrompt'));
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ devices: { noNotificationPrompt: true } });
    expect(latest!.policy?.organisation?.devices.noNotificationPrompt).toBe(false);
  });
});
