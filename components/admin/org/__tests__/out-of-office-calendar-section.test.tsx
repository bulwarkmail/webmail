import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Calendars > Out-of-office: the vacationBlockCalendar lock,
// with the value users get.

let stored: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      stored = JSON.parse(String(init.body));
      return new Response('{"ok":true}');
    }
    return new Response(JSON.stringify(stored));
  }),
  withBasePath: (p: string) => p,
  getPathPrefix: () => '',
}));

import { OutOfOfficeCalendarSection } from '../sections/out-of-office-calendar-section';
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
  return <OutOfOfficeCalendarSection draft={draft} />;
}

beforeEach(() => {
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Out-of-office calendar section', () => {
  it('lets users choose by default and locks the block on or off with its value', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('org-ooo-notes')).toBeInTheDocument());
    const select = screen.getByLabelText('Out-of-office blocks the calendar') as HTMLSelectElement;
    expect(select.value).toBe('users');
    fireEvent.change(select, { target: { value: 'never' } });
    expect(latest!.restriction('vacationBlockCalendar').value).toEqual({ locked: true, value: false });
    fireEvent.change(select, { target: { value: 'always' } });
    await act(async () => { await latest!.save(); });
    expect((stored.restrictions as Record<string, unknown>).vacationBlockCalendar).toEqual({ locked: true, value: true });
    fireEvent.change(select, { target: { value: 'users' } });
    expect(latest!.restriction('vacationBlockCalendar').value).toBeUndefined();
  });

  it('writes a scope\'s lock only into that scope', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('org-ooo-notes')).toBeInTheDocument());
    act(() => latest!.setScopeId('sales'));
    fireEvent.change(screen.getByLabelText('Out-of-office blocks the calendar'), { target: { value: 'never' } });
    expect(latest!.policy?.scopes?.[0].policy.restrictions).toEqual({ vacationBlockCalendar: { locked: true, value: false } });
    expect(latest!.policy?.restrictions.vacationBlockCalendar).toBeUndefined();
  });
});
