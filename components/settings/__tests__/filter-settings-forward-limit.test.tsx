import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterAction, FilterRule, SieveCapabilities } from '@/lib/jmap/sieve-types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { FilterSettings } from '../filter-settings';

// The redirect limit on the settings page: the real page and rule dialog,
// with a server that allows one redirect per message, as Stalwart does.

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const CAPABILITIES: SieveCapabilities = {
  implementation: 'Stalwart',
  maxSizeScript: 102400,
  sieveExtensions: ['fileinto', 'mailbox', 'imap4flags', 'copy'],
  notificationMethods: [],
  externalLists: [],
  maxNumberRedirects: 1,
};

const forward: FilterAction = { type: 'forward', value: 'colleague@example.com' };
const rule = (id: string, name: string, actions: FilterAction[], stopProcessing: boolean): FilterRule => ({
  id,
  name,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'reports@vendor.example' }],
  actions,
  stopProcessing,
});
// Forwards to a colleague, deletes silently, and stops processing.
const vendor = (stops = true) => rule('vendor', 'Vendor reports', [forward, { type: 'discard' }], stops);
const everyoneElse = rule('rest', 'Everyone else', [{ type: 'forward', value: 'office@example.com' }], false);

const initial = {
  auth: useAuthStore.getState(),
  email: useEmailStore.getState(),
  filter: useFilterStore.getState(),
};

beforeEach(() => {
  useAuthStore.setState({ client: { updateSieveScript: vi.fn(async () => {}), getSieveAccountId: () => 'primary' } as never });
  useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) as never });
});

afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
});

function openSettings(rules: FilterRule[]) {
  useFilterStore.setState({
    rules,
    isSupported: true,
    isLoading: false,
    isOpaque: false,
    activeScriptId: 'script-1',
    selectedAccountId: 'primary',
    sieveCapabilities: CAPABILITIES,
    selectAccount: vi.fn(async () => {}),
  });
  render(<FilterSettings />);
}

const forwardOption = (dialog: ReturnType<typeof within>) =>
  dialog.getAllByRole('combobox', { name: 'actions' })[0].querySelector('option[value="forward"]') as HTMLOptionElement;

describe('the redirect limit on the settings page', () => {
  it('offers forwarding in a new rule below one that forwards and stops', () => {
    openSettings([vendor()]);
    fireEvent.click(screen.getByText('add_rule'));
    const dialog = within(screen.getByRole('dialog'));
    expect(forwardOption(dialog).disabled).toBe(false);
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('keeps forwarding locked below a rule that forwards and lets messages go on', () => {
    openSettings([vendor(false)]);
    fireEvent.click(screen.getByText('add_rule'));
    expect(forwardOption(within(screen.getByRole('dialog'))).disabled).toBe(true);
  });

  it('says so in the list when the order lets one message collect too many', () => {
    openSettings([everyoneElse, vendor()]);
    expect(screen.getByText('forward_limit')).toBeInTheDocument();
  });

  it('says nothing in the list when the rule that stops comes first', () => {
    openSettings([vendor(), everyoneElse]);
    expect(screen.queryByText('forward_limit')).toBeNull();
  });

  it('says so in the list once a rule is switched on that lets one message collect too many', async () => {
    openSettings([{ ...everyoneElse, enabled: false }, vendor()]);
    expect(screen.queryByText('forward_limit')).toBeNull();
    fireEvent.click(within(screen.getByRole('list', { name: 'rule_list' })).getAllByRole('switch')[0]);
    // Saved, not put back.
    await waitFor(() => expect(useFilterStore.getState().rawScript).toContain('redirect "office@example.com"'));
    expect(screen.getByText('forward_limit')).toBeInTheDocument();
  });

  it('says so in the list once a rule is moved where one message collects too many', async () => {
    openSettings([vendor(), everyoneElse]);
    expect(screen.queryByText('forward_limit')).toBeNull();
    const [vendorRow, restRow] = within(screen.getByRole('list', { name: 'rule_list' })).getAllByRole('listitem');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(restRow, { dataTransfer });
    fireEvent.dragOver(vendorRow, { dataTransfer });
    fireEvent.drop(vendorRow, { dataTransfer });
    await waitFor(() => expect(useFilterStore.getState().rawScript).toMatch(/# Rule: Everyone else[\s\S]*# Rule: Vendor reports/));
    expect(screen.getByText('forward_limit')).toBeInTheDocument();
  });

  it('counts the forward of an edited rule once', () => {
    openSettings([vendor(), everyoneElse]);
    fireEvent.click(screen.getByText('Everyone else'));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByText('forward_limit')).toBeNull();
  });

  it('does not count a forward behind a Stop action', () => {
    const office: FilterAction = { type: 'forward', value: 'office@example.com' };
    openSettings([rule('cut', 'Cut short', [forward, { type: 'stop' }, office], false)]);
    fireEvent.click(screen.getByText('Cut short'));
    expect(within(screen.getByRole('dialog')).queryByText('forward_limit')).toBeNull();
  });

  it('puts a new rule above the rules managed elsewhere', () => {
    const archive: FilterAction = { type: 'forward', value: 'archive@example.org' };
    openSettings([{ ...rule('ext', 'Managed elsewhere', [archive], true), origin: 'external' }]);
    fireEvent.click(screen.getByText('add_rule'));
    const dialog = within(screen.getByRole('dialog'));
    // A message the new rule matches still reaches the one below it ...
    expect(forwardOption(dialog).disabled).toBe(true);
    // ... unless the new rule stops.
    fireEvent.click(dialog.getByLabelText('stop_processing'));
    expect(forwardOption(dialog).disabled).toBe(false);
  });

  it('warns in the dialog once the rule above stops no more', () => {
    openSettings([vendor(), everyoneElse]);
    fireEvent.click(screen.getByText('Vendor reports'));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByText('forward_limit')).toBeNull();
    // Without its stop, a vendor report also reaches the rule below.
    fireEvent.click(dialog.getByLabelText('stop_processing'));
    expect(dialog.getByText('forward_limit')).toBeInTheDocument();
  });
});
