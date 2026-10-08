import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { SieveCapabilities } from '@/lib/jmap/sieve-types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { FilterSettings } from '../filter-settings';

// The real settings page and its dialogs, against what happens in the
// background while the user types: the connection check every 30 seconds,
// a mailbox refresh, and a reload of the filters (another device changed
// the script).

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const CAPABILITIES: SieveCapabilities = {
  implementation: 'Stalwart',
  maxSizeScript: 102400,
  sieveExtensions: ['fileinto', 'mailbox', 'imap4flags', 'copy'],
  notificationMethods: [],
  externalLists: [],
  maxNumberRedirects: 1,
};

const initial = {
  auth: useAuthStore.getState(),
  email: useEmailStore.getState(),
  filter: useFilterStore.getState(),
};

beforeEach(() => {
  useAuthStore.setState({ client: { updateSieveScript: vi.fn(async () => {}), getSieveAccountId: () => 'primary' } as never });
  useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) as never });
  useFilterStore.setState({
    rules: [],
    isSupported: true,
    isLoading: false,
    error: null,
    isOpaque: false,
    activeScriptId: 'script-1',
    selectedAccountId: 'primary',
    sieveCapabilities: CAPABILITIES,
    selectAccount: vi.fn(async () => {}),
  });
});

afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
});

function typeNewRule() {
  render(<FilterSettings />);
  fireEvent.click(screen.getByText('add_rule'));
  const name = screen.getByPlaceholderText('rule_name_placeholder');
  name.focus();
  fireEvent.change(name, { target: { value: 'News' } });
  return name;
}

describe('typing in a dialog on the filter page while things happen in the background', () => {
  it('keeps the focus in the rule name through the connection check', () => {
    const name = typeNewRule();
    // What the ping every 30 seconds does: it sets the connection state again.
    act(() => useAuthStore.setState({ connectionLost: false }));
    expect(document.activeElement).toBe(name);
  });

  it('keeps the focus in the rule name through a mailbox refresh', () => {
    const name = typeNewRule();
    act(() => useEmailStore.setState({ mailboxes: [] }));
    expect(document.activeElement).toBe(name);
  });

  it('keeps the focus in the Sieve editor through the connection check', () => {
    render(<FilterSettings />);
    fireEvent.click(screen.getByText('raw_editor'));
    const script = screen.getByLabelText('script_content');
    script.focus();
    act(() => useAuthStore.setState({ connectionLost: false }));
    expect(document.activeElement).toBe(script);
  });

  it('keeps the rule dialog and what was typed through a reload of the filters', () => {
    typeNewRule();
    act(() => useFilterStore.setState({ isLoading: true }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => useFilterStore.setState({ isLoading: false }));
    expect(screen.getByPlaceholderText('rule_name_placeholder')).toHaveValue('News');
  });

  it('keeps the Sieve editor and what was typed through a reload of the filters', () => {
    render(<FilterSettings />);
    fireEvent.click(screen.getByText('raw_editor'));
    fireEvent.change(screen.getByLabelText('script_content'), { target: { value: 'keep;' } });
    act(() => useFilterStore.setState({ isLoading: true }));
    act(() => useFilterStore.setState({ isLoading: false }));
    expect(screen.getByLabelText('script_content')).toHaveValue('keep;');
  });

  it('keeps the rule dialog through a reload that fails', () => {
    typeNewRule();
    act(() => useFilterStore.setState({ error: 'offline' }));
    expect(screen.getByPlaceholderText('rule_name_placeholder')).toHaveValue('News');
  });

  it('still shows the loading state when no dialog is open', () => {
    render(<FilterSettings />);
    act(() => useFilterStore.setState({ isLoading: true }));
    expect(screen.getByText('loading')).toBeInTheDocument();
  });
});
