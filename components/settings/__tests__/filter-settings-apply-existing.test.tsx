import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule, SieveCapabilities } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useSettingsStore } from '@/stores/settings-store';

// settings-13 (usability pass 2026-11-04): a rule made in Settings only sees
// new mail, so its dialog offers to apply it to the Inbox; the raw Sieve
// editor is an advanced tool.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), progress: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

const target = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/filters/quick-rule-target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/filters/quick-rule-target')>()),
  resolveMailboxRuleTarget: () => target.value,
}));

const { FilterSettings } = await import('../filter-settings');

const CAPABILITIES: SieveCapabilities = {
  implementation: 'Stalwart',
  maxSizeScript: 102400,
  sieveExtensions: ['fileinto', 'mailbox', 'mailboxid', 'imap4flags'],
  notificationMethods: [],
  externalLists: [],
  maxNumberRedirects: 1,
};

const inbox = {
  id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0, totalEmails: 2, unreadEmails: 0, totalThreads: 2,
  unreadThreads: 0, myRights: {}, isSubscribed: true, isShared: false,
} as unknown as Mailbox;

let queryEmailFields: ReturnType<typeof vi.fn>;
let client: Record<string, unknown>;

const initial = {
  auth: useAuthStore.getState(),
  email: useEmailStore.getState(),
  filter: useFilterStore.getState(),
  settings: useSettingsStore.getState(),
};

beforeEach(() => {
  Object.values(toast).forEach((fn) => fn.mockClear());
  queryEmailFields = vi.fn(async () => [
    { id: 'e1', mailboxIds: { inbox: true }, keywords: {}, from: [{ email: 'news@example.org' }], 'header:From:asAddresses:all': [[{ email: 'news@example.org' }]] },
    { id: 'e2', mailboxIds: { inbox: true }, keywords: {}, from: [{ email: 'bob@example.net' }], 'header:From:asAddresses:all': [[{ email: 'bob@example.net' }]] },
  ]);
  client = {
    updateSieveScript: vi.fn(async () => {}),
    getSieveAccountId: () => 'primary',
    queryEmailFields,
    batchUpdateKeywords: vi.fn(async () => {}),
  };
  target.value = {
    client, clientAccountId: null, key: 'k', accountId: 'primary', sieveAccountId: 'primary',
    shared: false, supportsSieve: true, mailboxes: [inbox],
  };
  useAuthStore.setState({ client: client as never });
  useEmailStore.setState({ mailboxes: [inbox], fetchMailboxes: vi.fn(async () => {}) as never });
  useSettingsStore.setState({ showAdvancedSettings: false });
});

afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
  useSettingsStore.setState(initial.settings, true);
});

function showSettings(rules: FilterRule[] = [], extra: Record<string, unknown> = {}) {
  useFilterStore.setState({
    rules,
    isSupported: true,
    isLoading: false,
    isOpaque: false,
    activeScriptId: 'script-1',
    selectedAccountId: 'primary',
    sieveCapabilities: CAPABILITIES,
    selectAccount: vi.fn(async () => {}),
    ...extra,
  });
  render(<FilterSettings />);
}

async function fillRule(from: string, action: string) {
  fireEvent.click(screen.getByText('add_rule'));
  fireEvent.change(screen.getByLabelText('rule_name'), { target: { value: 'News' } });
  fireEvent.change(screen.getByLabelText('condition_value'), { target: { value: from } });
  fireEvent.change(screen.getAllByLabelText('actions')[0], { target: { value: action } });
}

// settings-p2-6: the offer is a box in the rule's dialog, with the number of
// messages it would change, not a toast that is gone in a few seconds.
describe('a rule in Settings › Filters', () => {
  it('offers, in its dialog, to apply it to the messages already in the Inbox', async () => {
    showSettings();
    await fillRule('news@example.org', 'star');
    const box = await screen.findByRole('checkbox', { name: 'apply_existing_count' }, { timeout: 2000 });
    expect(box).toBeEnabled();
    expect(queryEmailFields).toHaveBeenCalled();
    fireEvent.click(box);
    queryEmailFields.mockClear();
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('rule_applied', expect.anything()));
    // Saving ran the rule; no toast offered it.
    expect(queryEmailFields).toHaveBeenCalled();
    expect(toast.success.mock.calls.some(([, options]) => options?.action)).toBe(false);
  });

  it('runs nothing on old mail when the box is left empty', async () => {
    showSettings();
    await fillRule('news@example.org', 'star');
    await screen.findByRole('checkbox', { name: 'apply_existing_count' }, { timeout: 2000 });
    queryEmailFields.mockClear();
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(client.updateSieveScript).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(queryEmailFields).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('greys the box when no message in the Inbox matches', async () => {
    showSettings();
    await fillRule('nobody@example.com', 'star');
    await waitFor(() => expect(queryEmailFields).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('apply_existing_none')).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'apply_existing_in' })).toBeDisabled();
  });

  it('is greyed for a rule that can only act on arriving mail', async () => {
    showSettings();
    await fillRule('news@example.org', 'discard');
    expect(screen.getByRole('checkbox', { name: 'apply_existing_in' })).toBeDisabled();
    expect(screen.getByText('apply_existing_unsupported')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 500));
    expect(queryEmailFields).not.toHaveBeenCalled();
  });
});

describe('the rule list', () => {
  it('says what its switch does', () => {
    showSettings([{
      id: 'r1', name: 'News', enabled: true, matchType: 'all',
      conditions: [{ field: 'from', comparator: 'contains', value: 'news@example.org' }],
      actions: [{ type: 'star' }], stopProcessing: false,
    } as FilterRule]);
    expect(screen.getByRole('switch', { name: 'show_rule_details' })).toBeInTheDocument();
    expect(screen.queryByText('expanded_view')).toBeNull();
  });
});

describe('the raw Sieve editor button', () => {
  it('is hidden while the advanced settings are off', () => {
    showSettings();
    expect(screen.queryByText('raw_editor')).toBeNull();
  });

  it('shows with the advanced settings on', () => {
    useSettingsStore.setState({ showAdvancedSettings: true });
    showSettings();
    expect(screen.getByText('raw_editor')).toBeInTheDocument();
  });

  it('stays for a script only the raw editor can change', () => {
    showSettings([], { isOpaque: true, rawScript: 'keep;' });
    expect(screen.getByText('raw_editor')).toBeInTheDocument();
  });
});
