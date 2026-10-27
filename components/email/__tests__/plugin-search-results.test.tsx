import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { setActionDispatcher } from '@/lib/plugin-sandbox/actions';
import type { ProvidedSearchResult } from '@/lib/plugin-search-results';
import type { Email } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePluginStore } from '@/stores/plugin-store';
import { PluginSearchResults } from '../plugin-search-results';

// The block above a search's message list with the entries plugins returned
// from onProvideSearchResults; a click goes back to the plugin as onAction,
// or opens the message an entry names.

const result = (pluginId: string, key: string, source?: string): ProvidedSearchResult =>
  ({ pluginId, key, title: `Title ${key}`, snippet: `Snippet ${key}`, ...(source ? { source } : {}) });

const dispatch = vi.fn(async () => {});

/** A login whose primary account is `primary`, reading `shared` accounts too. */
const client = (primary: string, shared: string[] = []) => ({
  getAccountId: () => primary,
  getSharedAccounts: () => [primary, ...shared].map((id) => ({ id, name: id, isPrimary: id === primary, capabilities: { mail: true } })),
});

const withEmail = (key: string, email: { id: string; accountId?: string }): ProvidedSearchResult =>
  ({ ...result('crm', key, 'CRM'), email });

beforeEach(() => {
  setActionDispatcher(dispatch);
  usePluginStore.setState({ plugins: [{ id: 'chat', name: 'Team chat' }] } as never);
  useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS }, selectedEmail: null });
  useAuthStore.setState({
    activeAccountId: 'login-1',
    getAllConnectedClients: () => new Map([['login-2', client('acc-2')], ['login-1', client('acc-1', ['group-1'])]]),
  } as never);
});

afterEach(() => {
  setActionDispatcher(null);
  dispatch.mockClear();
});

describe('PluginSearchResults', () => {
  it('shows nothing outside a search', () => {
    useEmailStore.setState({ searchQuery: '', externalSearchResults: [result('crm', 'a', 'CRM')] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the entries of a search by filters alone', () => {
    useEmailStore.setState({
      searchQuery: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@x.test' },
      externalSearchResults: [result('crm', 'a', 'CRM')],
    });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.getByRole('region', { name: 'CRM' })).toHaveTextContent('Title a');
  });

  it('groups the entries by source, the plugin\'s name without one', () => {
    useEmailStore.setState({
      searchQuery: 'resolution',
      externalSearchResults: [result('crm', 'a', 'CRM'), result('chat', 'b'), result('crm', 'c', 'CRM')],
    });
    render(<PluginSearchResults surface="search-results" />);

    expect(screen.getByRole('region', { name: 'CRM' })).toHaveTextContent('Title a');
    expect(screen.getByRole('region', { name: 'CRM' })).toHaveTextContent('Title c');
    expect(screen.getByRole('region', { name: 'Team chat' })).toHaveTextContent('Snippet b');
  });

  it('sends a click to the plugin that gave the entry, with the query', () => {
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'mail-123', 'CRM')] });
    render(<PluginSearchResults surface="search-results" />);

    fireEvent.click(screen.getByRole('button', { name: /Title mail-123/ }));

    expect(dispatch).toHaveBeenCalledWith('crm', 'search-results', 'mail-123', { query: 'resolution' });
  });

  it('opens the message an entry names in the reader, not the plugin', () => {
    const open = vi.fn();
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [withEmail('mail-1', { id: 'M1' })] });
    render(<PluginSearchResults surface="search-results" onOpenEmail={open} />);

    fireEvent.click(screen.getByRole('button', { name: /Title mail-1/ }));

    expect(open).toHaveBeenCalledWith({ id: 'M1', sourceClientAccountId: 'login-1', sourceAccountId: 'acc-1' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('opens a message of a shared account through the login reaching it, the active one first', () => {
    const open = vi.fn();
    useEmailStore.setState({
      searchQuery: 'resolution',
      externalSearchResults: [withEmail('g', { id: 'M1', accountId: 'group-1' }), withEmail('o', { id: 'M2', accountId: 'acc-2' })],
    });
    render(<PluginSearchResults surface="search-results" onOpenEmail={open} />);

    fireEvent.click(screen.getByRole('button', { name: /Title g/ }));
    fireEvent.click(screen.getByRole('button', { name: /Title o/ }));

    expect(open).toHaveBeenNthCalledWith(1, { id: 'M1', sourceClientAccountId: 'login-1', sourceAccountId: 'group-1' });
    expect(open).toHaveBeenNthCalledWith(2, { id: 'M2', sourceClientAccountId: 'login-2', sourceAccountId: 'acc-2' });
  });

  it('sends the click to the plugin when no login reaches the message\'s account', () => {
    const open = vi.fn();
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [withEmail('mail-1', { id: 'M1', accountId: 'elsewhere' })] });
    render(<PluginSearchResults surface="search-results" onOpenEmail={open} />);

    fireEvent.click(screen.getByRole('button', { name: /Title mail-1/ }));

    expect(open).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('crm', 'search-results', 'mail-1', { query: 'resolution' });
  });

  it('marks the entry whose message is open, in the same account', () => {
    useEmailStore.setState({
      searchQuery: 'resolution',
      externalSearchResults: [withEmail('a', { id: 'M1', accountId: 'group-1' }), withEmail('b', { id: 'M1' })],
      selectedEmail: { id: 'M1', sourceAccountId: 'group-1' } as Email,
    });
    render(<PluginSearchResults surface="search-results" onOpenEmail={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Title a/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Title b/ })).not.toHaveAttribute('aria-current');

    act(() => useEmailStore.setState({ selectedEmail: { id: 'M1' } as Email }));
    expect(screen.getByRole('button', { name: /Title a/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /Title b/ })).toHaveAttribute('aria-current', 'true');
  });

  it('folds a group', () => {
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'a', 'CRM')] });
    render(<PluginSearchResults surface="search-results" />);

    const heading = screen.getByRole('button', { name: /^CRM/ });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(heading);

    expect(screen.queryByText('Title a')).toBeNull();
    expect(heading).toHaveAttribute('aria-expanded', 'false');
  });
});
