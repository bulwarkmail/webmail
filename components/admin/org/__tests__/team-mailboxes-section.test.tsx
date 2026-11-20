import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Team mailboxes: one switch, off by default, saved per scope.

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

import { TeamMailboxesSection } from '../sections/team-mailboxes-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'support', label: 'Support team', match: { groups: ['support@example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <TeamMailboxesSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-team-mailboxes-enabled')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Team mailboxes section', () => {
  it('is one switch, off by default, saved as organisation.teamMailboxes.enabled', async () => {
    await renderSection();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    const toggle = screen.getByTestId('org-team-mailboxes-enabled');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => { fireEvent.click(toggle); });
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { teamMailboxes: unknown }).teamMailboxes).toEqual({ enabled: true });
    expect(screen.getByRole('link', { name: 'How team mailboxes work' }).getAttribute('href')).toBe('https://bulwarkmail.org/docs/guides/organisation/team-mailboxes');
  });

  it('turns it on for one group only when that group is picked', async () => {
    await renderSection();
    act(() => latest!.setScopeId('support'));
    act(() => { fireEvent.click(screen.getByTestId('org-team-mailboxes-enabled')); });
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ teamMailboxes: { enabled: true } });
    expect(latest!.policy?.organisation?.teamMailboxes?.enabled ?? false).toBe(false);
  });
});
