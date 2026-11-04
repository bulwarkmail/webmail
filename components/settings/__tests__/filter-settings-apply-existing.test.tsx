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
// new mail, so after Save the page offers to apply it to the Inbox; the raw
// Sieve editor is an advanced tool.

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

async function createRule(from: string, action: string) {
  fireEvent.click(screen.getByText('add_rule'));
  fireEvent.change(screen.getByLabelText('rule_name'), { target: { value: 'News' } });
  fireEvent.change(screen.getByLabelText('condition_value'), { target: { value: from } });
  fireEvent.change(screen.getAllByLabelText('actions')[0], { target: { value: action } });
  fireEvent.click(screen.getByText('save'));
}

describe('a new rule in Settings › Filters', () => {
  it('offers to apply it to the messages already in the Inbox', async () => {
    showSettings();
    await createRule('news@example.org', 'star');
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, options] = toast.success.mock.calls.at(-1)!;
    expect(options.action.label).toBe('apply_to_existing');
    expect(queryEmailFields).toHaveBeenCalled();
  });

  it('says nothing more when no message in the Inbox matches', async () => {
    showSettings();
    await createRule('nobody@example.com', 'star');
    await waitFor(() => expect(queryEmailFields).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('is not offered for a rule that can only act on arriving mail', async () => {
    showSettings();
    await createRule('news@example.org', 'discard');
    await waitFor(() => expect(client.updateSieveScript).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(queryEmailFields).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
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
