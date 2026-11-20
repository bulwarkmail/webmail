import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';
import { EVERYONE, useOrgScopeStore } from '@/components/admin/org/use-org-policy-draft';
import { ADMIN_GROUP_LABELS } from '@/components/admin/admin-page-icons';
import { adminPageDef } from '@/lib/admin/admin-nav';

// Usability 2026-11-04, settings-22: features, locked settings and defaults
// sit with the organisation pages under "Users", and features take the same
// "Applies to" picker as the rest.

const puts: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}');
    }
    return new Response(JSON.stringify(stored), { headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

import { PolicyPage } from '../_pages/policy';

const BASE = {
  restrictions: {}, features: { calendarEnabled: true, accountArchiveEnabled: false }, defaults: {}, themePolicy: {},
  forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
  pushRelays: [], pushRelayUrl: '', pushRelayUrlLocked: false, defaultSidebarApps: [],
  scopes: [{ id: 'sales', label: 'Sales', match: { domains: ['sales.example'] }, policy: {} }],
};

const features = () => document.querySelector<HTMLElement>('[data-settings-section="features"]')!;
function rowSwitch(label: string): HTMLElement {
  let el: HTMLElement | null = within(features()).getByText(label, { selector: 'label' });
  while (el && !el.hasAttribute('data-search-label')) el = el.parentElement;
  return within(el!).getByRole('switch');
}

beforeEach(() => {
  puts.length = 0;
  stored = JSON.parse(JSON.stringify(BASE));
  useOrgScopeStore.setState({ scopeId: EVERYONE });
});
afterEach(() => {
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

describe('Features and settings', () => {
  it('sits in the Users group with the organisation pages', () => {
    const page = adminPageDef('policy');
    expect(page.label).toBe('Features and settings');
    expect(page.group).toBe('organisation');
    expect(adminPageDef('organisation').group).toBe('organisation');
    expect(ADMIN_GROUP_LABELS.organisation).toBe('Users');
  });

  it('turns a feature off for one group only', async () => {
    render(<PolicyPage />);
    await waitFor(() => expect(features()).toBeTruthy());
    const picker = within(features()).getByRole('group', { name: 'Applies to' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Sales' }));

    const calendar = rowSwitch('Calendar');
    expect(calendar.getAttribute('aria-checked')).toBe('true');
    expect(within(features()).getAllByText('From Everyone: On').length).toBeGreaterThan(0);
    fireEvent.click(calendar);

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const saved = puts[0] as { features: Record<string, boolean>; scopes: Array<{ id: string; policy: { features?: Record<string, boolean> } }> };
    expect(saved.features.calendarEnabled).toBe(true);
    expect(saved.scopes[0].policy.features).toEqual({ calendarEnabled: false });
  });

  it('keeps features the server checks itself for everyone', async () => {
    render(<PolicyPage />);
    await waitFor(() => expect(features()).toBeTruthy());
    fireEvent.click(within(within(features()).getByRole('group', { name: 'Applies to' })).getByRole('button', { name: 'Sales' }));
    expect(rowSwitch('Account list backup')).toBeDisabled();
  });

  // #1806
  it('gives one scope its own default sidebar apps', async () => {
    stored.defaultSidebarApps = [{ id: 'admin-app-intranet', name: 'Intranet', url: 'https://intranet.example.com', icon: 'Globe', openMode: 'tab', showOnMobile: false }];
    render(<PolicyPage />);
    await waitFor(() => expect(features()).toBeTruthy());
    const section = document.querySelector<HTMLElement>('[data-settings-section="sidebar-apps"]')!;
    fireEvent.click(within(within(section).getByRole('group', { name: 'Applies to' })).getByRole('button', { name: 'Sales' }));
    expect(within(section).queryByDisplayValue('Intranet')).toBeNull();
    expect(within(section).getByText(/From Everyone: 1 app\./)).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Set apps for this scope' }));
    expect(within(section).getByDisplayValue('Intranet')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Add app' }));
    const names = within(section).getAllByLabelText('Name');
    fireEvent.change(names[1], { target: { value: 'CRM' } });
    fireEvent.change(within(section).getAllByLabelText('URL')[1], { target: { value: 'https://crm.sales.example' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const saved = puts[0] as { defaultSidebarApps: Array<{ name: string }>; scopes: Array<{ policy: { defaultSidebarApps?: Array<{ name: string; url: string }> } }> };
    expect(saved.defaultSidebarApps.map((a) => a.name)).toEqual(['Intranet']);
    expect(saved.scopes[0].policy.defaultSidebarApps?.map((a) => [a.name, a.url])).toEqual([
      ['Intranet', 'https://intranet.example.com'],
      ['CRM', 'https://crm.sales.example'],
    ]);
  });

  it('uses sentence case and plain words for the features', async () => {
    render(<PolicyPage />);
    await waitFor(() => expect(features()).toBeTruthy());
    expect(within(features()).queryByText('Settings Export/Import')).toBeNull();
    expect(within(features()).getByText('Settings backup')).toBeTruthy();
    expect(within(features()).getByText('Hover buttons')).toBeTruthy();
  });
});
