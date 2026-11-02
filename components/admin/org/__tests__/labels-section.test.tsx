import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Classification: presets, the list editor, default and
// required, the extra header, the VS-NfD warning, and a scope that has its
// own scheme as a whole (labels merge as one section).

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

import { LabelsSection } from '../sections/labels-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';
import { sanitizeOrganisationPolicy } from '@/lib/admin/organisation-policy';
import { resolvePolicy } from '@/lib/admin/policy-scopes';
import { DEFAULT_POLICY } from '@/lib/admin/types';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'gov', label: 'Gov', match: { domains: ['gov.example'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <LabelsSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-labels-vsnfd-warning')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Classification section', () => {
  it('says plainly that a label does not make mail meet the VS-NfD rules', async () => {
    await renderSection();
    const warning = screen.getByTestId('org-labels-vsnfd-warning').textContent ?? '';
    expect(warning).toContain('VSA § 50, § 55');
    expect(warning).toContain('BSI-approved encryption');
    expect(warning).toContain('are not BSI-approved products');
  });

  it('starts from the generic preset and saves it with the default', async () => {
    await renderSection();
    fireEvent.change(screen.getByTestId('org-labels-preset'), { target: { value: 'generic' } });
    expect(screen.getAllByTestId('org-label-item')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('org-labels-required'));
    await act(async () => { await latest!.save(); });
    const labels = (puts[0].organisation as { labels: { list: Array<{ id: string; subjectPrefix: string }>; defaultId: string; required: boolean } }).labels;
    expect(labels.list.map((l) => l.id)).toEqual(['public', 'internal', 'confidential', 'strictly-confidential']);
    expect(labels.defaultId).toBe('internal');
    expect(labels.required).toBe(true);
    // What the server keeps of it is the same.
    expect(sanitizeOrganisationPolicy(puts[0].organisation).labels.list[2].subjectPrefix).toBe('[Confidential]');
  });

  it('offers no grade above VS-NfD in the German preset', async () => {
    await renderSection();
    fireEvent.change(screen.getByTestId('org-labels-preset'), { target: { value: 'german-public-sector' } });
    const names = latest!.orgValue('labels', 'list').value.map((l) => l.name);
    expect(names).toEqual(['OFFEN', 'VS-NfD']);
    expect(latest!.orgValue('labels', 'list').value[1].marking).toBe('VS-NUR FÜR DEN DIENSTGEBRAUCH');
  });

  it('clears the default and the requirement with the last label', async () => {
    stored = { ...POLICY, organisation: { labels: { list: [{ id: 'a', name: 'A', color: '#000000' }], defaultId: 'a', required: true } } };
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Remove A' }));
    expect(latest!.orgValue('labels', 'defaultId').value).toBe('');
    expect(latest!.orgValue('labels', 'required').value).toBe(false);
  });

  it('stores the extra header name only when it is a header Bulwark doesn’t write', async () => {
    await renderSection();
    const field = screen.getByTestId('org-labels-extra-header');
    fireEvent.change(field, { target: { value: 'Sensitivity' } });
    expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('Bulwark writes this one itself'))).toBe(true);
    expect(latest!.orgValue('labels', 'extraHeader').value).toBe('');
    fireEvent.change(field, { target: { value: 'X-Classification' } });
    expect(latest!.orgValue('labels', 'extraHeader').value).toBe('X-Classification');
  });

  it('gives a scope its own scheme as a whole, and back', async () => {
    stored = { ...POLICY, organisation: { labels: { list: [{ id: 'a', name: 'A', color: '#000000' }], defaultId: 'a', required: true, extraHeader: 'X-Class' } } };
    await renderSection();
    act(() => latest!.setScopeId('gov'));
    expect(screen.getByTestId('org-labels-inherited').textContent).toContain('A');
    fireEvent.click(screen.getByTestId('org-labels-own'));
    expect(latest!.policy?.scopes?.[0].policy.organisation?.labels).toEqual({
      list: [{ id: 'a', name: 'A', color: '#000000', description: '', marking: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' }],
      defaultId: 'a', required: true, extraHeader: 'X-Class',
    });
    fireEvent.change(screen.getByTestId('org-labels-preset'), { target: { value: 'german-public-sector' } });
    const resolved = resolvePolicy({ ...DEFAULT_POLICY, ...(latest!.policy as object) } as never, { email: 'x@gov.example', groups: [] }).policy;
    expect(resolved.organisation!.labels.list.map((l) => l.id)).toEqual(['offen', 'vs-nfd']);
    expect(resolved.organisation!.labels.defaultId).toBe('offen');
    expect(resolved.organisation!.labels.extraHeader).toBe('X-Class');
    fireEvent.click(screen.getByRole('button', { name: /Use Everyone/ }));
    expect(latest!.policy?.scopes?.[0].policy.organisation?.labels).toBeUndefined();
  });
});
