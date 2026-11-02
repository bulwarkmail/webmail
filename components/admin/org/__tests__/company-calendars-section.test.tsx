import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Calendars > Company calendars: the feeds list
// (organisation.calendars.feeds), per scope, with the notes on Lite and the
// upload limit.

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

import { CompanyCalendarsSection } from '../sections/company-calendars-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';
import { sanitizeOrganisationPolicy } from '@/lib/admin/organisation-policy';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: { calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics', color: '#16a34a', refreshMinutes: 60 }], freeBusyGroup: '' } },
  scopes: [{ id: 'team', label: 'Team', match: { groups: ['ent-team@example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <CompanyCalendarsSection draft={draft} />;
}

beforeEach(() => {
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Company calendars section', () => {
  it('adds a feed with its name, address and colour', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByTestId('org-feed-item')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('org-feed-add'));
    const names = screen.getAllByTestId('org-feed-name');
    fireEvent.change(names[1], { target: { value: 'Office closures' } });
    expect(screen.getByText(/Enter the address of the ICS feed/)).toBeInTheDocument();
    fireEvent.change(screen.getAllByTestId('org-feed-url')[1], { target: { value: 'webcal://intranet.example.org/closed.ics' } });
    await act(async () => { await latest!.save(); });
    const saved = sanitizeOrganisationPolicy(stored.organisation).calendars.feeds;
    expect(saved.map((f) => [f.name, f.url, f.refreshMinutes])).toEqual([
      ['Holidays', 'https://cal.example.org/h.ics', 60],
      ['Office closures', 'https://intranet.example.org/closed.ics', 60],
    ]);
  });

  it('adds a scope\'s feeds to that scope, showing Everyone\'s as inherited', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByTestId('org-feed-item')).toHaveLength(1));
    act(() => latest!.setScopeId('team'));
    expect(screen.getByTestId('org-feed-inherited')).toHaveTextContent('Holidays');
    fireEvent.click(screen.getByTestId('org-feed-add'));
    fireEvent.change(screen.getByTestId('org-feed-name'), { target: { value: 'Team' } });
    fireEvent.change(screen.getByTestId('org-feed-url'), { target: { value: 'https://cal.example.org/team.ics' } });
    const scopeFeeds = (latest!.policy?.scopes?.[0].policy.organisation as { calendars: { feeds: { name: string }[] } }).calendars.feeds;
    expect(scopeFeeds.map((f) => f.name)).toEqual(['Team']);
    expect(latest!.policy?.organisation?.calendars.feeds.map((f) => f.name)).toEqual(['Holidays']);
  });

  it('says what Lite needs and what a refresh costs', async () => {
    render(<Harness />);
    const notes = await screen.findByTestId('org-feed-notes');
    expect(notes).toHaveTextContent('Access-Control-Allow-Origin');
    expect(notes).toHaveTextContent('policy.json is a public file');
    expect(notes).toHaveTextContent('1000 files or 50 MB an hour');
    expect(notes).toHaveTextContent('intranet');
  });
});
