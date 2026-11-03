import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Devices > Offline mode (#523): devices.noOffline per scope.

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

import { OfflineSection } from '../sections/offline-section';
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
  return <OfflineSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-devices-noOffline')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Offline mode section', () => {
  it('is off by default and saves devices.noOffline', async () => {
    await renderSection();
    const toggle = screen.getByTestId('org-devices-noOffline');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { devices: { noOffline: boolean } }).devices.noOffline).toBe(true);
  });

  it('writes a scope override only into that scope', async () => {
    await renderSection();
    act(() => latest!.setScopeId('field'));
    fireEvent.click(screen.getByTestId('org-devices-noOffline'));
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ devices: { noOffline: true } });
    expect(latest!.policy?.organisation?.devices.noOffline).toBe(false);
  });

  it('says what a device keeps and links the docs', async () => {
    await renderSection();
    expect(screen.getByRole('link', { name: 'How offline mode works' }).getAttribute('href')).toBe('https://bulwarkmail.org/docs/guides/organisation/offline-mode');
    expect(document.body.textContent).toContain('Bulwark Lite reads the same policy but has no offline mode');
    expect(document.body.textContent).not.toContain('250 MB');
  });

  it('saves the caps as numbers and takes a cleared field as no cap', async () => {
    await renderSection();
    const days = screen.getByTestId('org-devices-offlineMaxDays') as HTMLInputElement;
    fireEvent.change(days, { target: { value: '45' } });
    fireEvent.change(screen.getByTestId('org-devices-offlineMaxAttachmentMb'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('org-devices-offlineMaxTotalMb'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('org-devices-noOfflineAttachments'));
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { devices: unknown }).devices).toMatchObject({
      offlineMaxDays: 45, offlineMaxAttachmentMb: 10, offlineMaxTotalMb: 200, noOfflineAttachments: true,
    });
    fireEvent.change(days, { target: { value: '' } });
    expect(latest!.policy?.organisation?.devices.offlineMaxDays).toBe(0);
    expect(days.value).toBe('');
  });

  it('writes a cap into the scope only', async () => {
    await renderSection();
    act(() => latest!.setScopeId('field'));
    fireEvent.change(screen.getByTestId('org-devices-offlineMaxDays'), { target: { value: '30' } });
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ devices: { offlineMaxDays: 30 } });
    expect(latest!.policy?.organisation?.devices.offlineMaxDays).toBe(0);
  });
});
