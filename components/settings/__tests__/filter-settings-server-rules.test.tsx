import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { parseScript } from '@/lib/sieve/parser';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { FilterSettings } from '../filter-settings';

// The server rules region is kept out of the rule list, but whatever it holds
// runs on the user's mail: the filters page shows it, read-only.

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const SCRIPT = [
  'require ["include", "copy"];',
  '',
  '# --- Server rules (managed outside Bulwark) ---',
  'include :personal :optional "host-rules";',
  'redirect :copy "archive@host.example";',
  '# --- End of server rules ---',
  '',
].join('\n');

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

function openSettings(serverRules: string) {
  useFilterStore.setState({
    rules: [],
    serverRules,
    isSupported: true,
    isLoading: false,
    isOpaque: false,
    activeScriptId: 'script-1',
    selectedAccountId: 'primary',
    selectAccount: vi.fn(async () => {}),
  });
  render(<FilterSettings />);
}

describe('server rules on the filters page', () => {
  it('shows what the region runs, including a forward', () => {
    const parsed = parseScript(SCRIPT);
    expect(parsed.rules).toEqual([]);
    openSettings(parsed.serverRules ?? '');
    const card = screen.getByTestId('server-rules');
    expect(card).toHaveTextContent('server_rules');
    expect(card).toHaveTextContent('redirect :copy "archive@host.example";');
    expect(card).toHaveTextContent('include :personal :optional "host-rules";');
  });

  it('shows nothing without a region', () => {
    openSettings('');
    expect(screen.queryByTestId('server-rules')).toBeNull();
  });
});
