import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Security > Phishing reports: the address (stored only when
// it is one), the format, the postmaster warning, and a scope override.

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

import { PhishingReportSection } from '../sections/phishing-report-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <PhishingReportSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-phishing-address')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Phishing reports section', () => {
  it('stores the address once it is one, and saves it with the format', async () => {
    await renderSection();
    const field = screen.getByTestId('org-phishing-address');
    fireEvent.change(field, { target: { value: 'security@' } });
    // The field's own alert; other alerts (announcements) may be on the page.
    await waitFor(() => expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes("isn't an email address"))).toBe(true));
    expect(latest!.orgValue('phishingReport', 'address').value).toBe('');
    fireEvent.change(field, { target: { value: 'Security@Example.org' } });
    expect(screen.queryAllByRole('alert').some((el) => el.textContent?.includes("isn't an email address"))).toBe(false);
    fireEvent.click(screen.getByTestId('org-phishing-format-arf'));
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { phishingReport: unknown }).phishingReport).toEqual({ address: 'security@example.org', format: 'arf' });
  });

  it('turns reporting off when the address is emptied', async () => {
    stored = { ...POLICY, organisation: { phishingReport: { address: 'soc@example.org', format: 'forward' } } };
    await renderSection();
    const field = screen.getByTestId('org-phishing-address') as HTMLInputElement;
    expect(field.value).toBe('soc@example.org');
    fireEvent.change(field, { target: { value: '' } });
    expect(latest!.orgValue('phishingReport', 'address').value).toBe('');
  });

  it('warns about postmaster@', async () => {
    await renderSection();
    expect(screen.queryByTestId('org-phishing-postmaster')).toBeNull();
    fireEvent.change(screen.getByTestId('org-phishing-address'), { target: { value: 'postmaster@example.org' } });
    expect(screen.getByTestId('org-phishing-postmaster').textContent).toContain('Stalwart analyses mail to it as reports');
  });

  it('writes a scope override only into that scope', async () => {
    await renderSection();
    act(() => latest!.setScopeId('team'));
    fireEvent.change(screen.getByTestId('org-phishing-address'), { target: { value: 'team-soc@example.org' } });
    expect(latest!.policy?.scopes?.[0].policy.organisation).toEqual({ phishingReport: { address: 'team-soc@example.org' } });
    expect(latest!.policy?.organisation?.phishingReport.address).toBe('');
  });
});
