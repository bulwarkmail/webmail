import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Proofreading: the admin's own notice text per language (#1836).

const puts: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/admin/plugins') return new Response('[]');
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

import { ProofreadingSection } from '../sections/proofreading-section';
import { useOrgPolicyDraft, useOrgScopeStore, EVERYONE } from '../use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  organisation: {},
  scopes: [{ id: 'family', label: 'Family', match: { domains: ['example.org'] }, policy: {} }],
};

let latest: ReturnType<typeof useOrgPolicyDraft> | null = null;
function Harness() {
  const draft = useOrgPolicyDraft('test');
  latest = draft;
  if (draft.loading) return null;
  return <ProofreadingSection draft={draft} />;
}

async function renderSection() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('org-proofreading-notice-add')).toBeInTheDocument());
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  latest = null;
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

describe('Proofreading notice editor', () => {
  it('saves the admin text per language as organisation.proofreading.notice', async () => {
    await renderSection();
    expect(screen.queryByTestId('org-proofreading-notice-text')).not.toBeInTheDocument();
    act(() => { fireEvent.change(screen.getByTestId('org-proofreading-notice-add'), { target: { value: 'de' } }); });
    act(() => { fireEvent.change(screen.getByTestId('org-proofreading-notice-text'), { target: { value: 'Der Text bleibt auf unserem Server.' } }); });
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { proofreading: unknown }).proofreading).toEqual({ notice: { de: 'Der Text bleibt auf unserem Server.' } });
  });

  it('removing the last language goes back to the built-in notice', async () => {
    stored = { ...POLICY, organisation: { proofreading: { notice: { en: 'Stays here.' } } } };
    await renderSection();
    expect((screen.getByTestId('org-proofreading-notice-text') as HTMLTextAreaElement).value).toBe('Stays here.');
    act(() => { fireEvent.click(screen.getByText(/Use the built-in notice in/)); });
    await act(async () => { await latest!.save(); });
    expect((puts[0].organisation as { proofreading: { notice: unknown } }).proofreading.notice).toEqual({});
  });

  it('a scope writes its own text without changing Everyone', async () => {
    useOrgScopeStore.setState({ scopeId: 'family' });
    await renderSection();
    act(() => { fireEvent.change(screen.getByTestId('org-proofreading-notice-add'), { target: { value: 'en' } }); });
    act(() => { fireEvent.change(screen.getByTestId('org-proofreading-notice-text'), { target: { value: 'Checked on our own server.' } }); });
    await act(async () => { await latest!.save(); });
    const saved = puts[0] as { organisation?: { proofreading?: { notice: unknown } }; scopes: Array<{ policy: { organisation?: unknown } }> };
    expect(saved.scopes[0].policy.organisation).toEqual({ proofreading: { notice: { en: 'Checked on our own server.' } } });
    expect(saved.organisation?.proofreading?.notice ?? {}).toEqual({});
  });
});
