import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Organisation > Proofreading: the four states for everyone or a group, the
// per-plugin lock, and the warning (with a shortcut) when proofreading is
// required but no checker plugin is forced on.

const puts: Array<Record<string, unknown>> = [];
const patches: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};
let plugins: Array<Record<string, unknown>> = [];
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/admin/plugins') {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        plugins = plugins.map((p) => (p.id === body.id ? { ...p, ...body } : p));
        return new Response('{"ok":true}');
      }
      return new Response(JSON.stringify(plugins));
    }
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

import { OrgProofreadingPage } from '../_pages/org-proofreading';
import { EVERYONE, useOrgScopeStore } from '@/components/admin/org/use-org-policy-draft';

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [], organisation: {},
  scopes: [{ id: 'sales', label: 'Sales', match: { groups: ['sales@example.org'] }, policy: {} }],
};

beforeEach(() => {
  puts.length = 0;
  patches.length = 0;
  stored = JSON.parse(JSON.stringify(POLICY));
  plugins = [
    { id: 'languagetool', name: 'Proofreading (LanguageTool)', enabled: true, forceEnabled: false, permissions: ['compose:check', 'http:proxy'] },
    { id: 'gravatar', name: 'Gravatar', enabled: true, permissions: ['http:fetch'] },
  ];
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});

const mainSelect = () => screen.getAllByRole('combobox')[0] as HTMLSelectElement;
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0] as { restrictions: Record<string, unknown>; defaults: Record<string, unknown>; scopes: Array<{ id: string; policy: Record<string, Record<string, unknown>> }> };
};

describe('Organisation > Proofreading', () => {
  it('lists only checker plugins', async () => {
    render(<OrgProofreadingPage />);
    expect(await screen.findByText('Proofreading (LanguageTool)')).toBeInTheDocument();
    expect(screen.queryByText('Gravatar')).toBeNull();
  });

  it('requires proofreading for everyone, warns until a checker is forced on, and forces it', async () => {
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    expect(screen.queryByTestId('proofreading-force-warning')).toBeNull();
    fireEvent.change(mainSelect(), { target: { value: 'on-locked' } });
    expect(await screen.findByTestId('proofreading-force-warning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Force Proofreading (LanguageTool) on for everyone' }));
    await waitFor(() => expect(patches).toEqual([{ id: 'languagetool', enabled: true, forceEnabled: true }]));
    await waitFor(() => expect(screen.queryByTestId('proofreading-force-warning')).toBeNull());
    const policy = await save();
    expect(policy.restrictions.proofreading).toEqual({ locked: true, value: true });
    expect(policy.defaults.proofreading).toBe(true);
  });

  it('turns it off and hides it for everyone', async () => {
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    fireEvent.change(mainSelect(), { target: { value: 'off-locked' } });
    const policy = await save();
    expect(policy.restrictions.proofreading).toEqual({ locked: true, value: false, hidden: true });
  });

  it('presets it on, without a lock', async () => {
    stored = { ...JSON.parse(JSON.stringify(POLICY)), restrictions: { proofreading: { locked: true, value: false, hidden: true } } };
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    expect(mainSelect().value).toBe('off-locked');
    fireEvent.change(mainSelect(), { target: { value: 'on' } });
    const policy = await save();
    expect(policy.restrictions.proofreading).toBeUndefined();
    expect(policy.defaults.proofreading).toBe(true);
  });

  it('requires it for one group only, and that group can inherit again', async () => {
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    fireEvent.click(screen.getByRole('button', { name: 'Sales' }));
    expect(mainSelect().value).toBe('inherit');
    fireEvent.change(mainSelect(), { target: { value: 'on-locked' } });
    const policy = await save();
    expect(policy.restrictions.proofreading).toBeUndefined();
    const sales = policy.scopes.find((s) => s.id === 'sales')!;
    expect(sales.policy.restrictions.proofreading).toEqual({ locked: true, value: true });
    expect(sales.policy.defaults.proofreading).toBe(true);
  });

  it('locks one plugin off', async () => {
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    fireEvent.change(screen.getByRole('combobox', { name: 'Proofreading with Proofreading (LanguageTool)' }), { target: { value: 'off-locked' } });
    const policy = await save();
    expect(policy.restrictions['proofreading.languagetool']).toEqual({ locked: true, value: false });
  });

  it('locks the writing language with a value', async () => {
    render(<OrgProofreadingPage />);
    await screen.findByText('Proofreading (LanguageTool)');
    fireEvent.change(screen.getByRole('combobox', { name: 'Writing language' }), { target: { value: 'de-CH' } });
    fireEvent.click(screen.getByLabelText('Lock'));
    const policy = await save();
    expect(policy.restrictions.writingLanguage).toEqual({ locked: true, value: 'de-CH' });
    expect(policy.defaults.writingLanguage).toBe('de-CH');
  });
});
