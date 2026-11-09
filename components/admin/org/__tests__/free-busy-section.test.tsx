import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Calendars > Free/busy sharing: the group every user's
// default calendar shares its free/busy with (calendars.freeBusyGroup).

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

import { FreeBusySection } from '../sections/free-busy-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'sales', label: 'Sales', match: { groups: ['sales@example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <FreeBusySection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-free-busy-notes')).toBeInTheDocument());
  return screen.getByLabelText('Share free/busy with (group address)') as HTMLInputElement;
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Free/busy sharing section', () => {
  it('says CalDAV-only users are not covered and points at the directory setting', async () => {
    await renderSection();
    const notes = screen.getByTestId('org-free-busy-notes').textContent ?? '';
    expect(notes).toContain('never sign in to Bulwark');
    expect(notes).toContain('Allow Directory Queries');
  });

  it('saves a group address and keeps a half-typed one out of the policy', async () => {
    const field = await renderSection();
    fireEvent.change(field, { target: { value: 'staff@' } });
    expect(screen.getByText('Enter a group address like staff@example.com.')).toBeInTheDocument();
    expect(latest!.orgValue('calendars', 'freeBusyGroup').value).toBe('');
    fireEvent.change(field, { target: { value: 'Staff@Example.org ' } });
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { calendars: { freeBusyGroup: string } }).calendars.freeBusyGroup).toBe('staff@example.org');
  });

  it('writes a scope override only into that scope', async () => {
    const field = await renderSection();
    act(() => latest!.setScopeId('sales'));
    fireEvent.change(field, { target: { value: 'sales@example.org' } });
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ calendars: { freeBusyGroup: 'sales@example.org' } });
    expect(latest!.policy?.organisation?.calendars.freeBusyGroup).toBe('');
  });
});
