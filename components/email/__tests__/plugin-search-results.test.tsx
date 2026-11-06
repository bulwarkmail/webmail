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
import { DEFAULT_SHARE, MAX_SHARE, MIN_HEIGHT, PENDING_GRACE_MS, PluginSearchResults } from '../plugin-search-results';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'more_results_searching') return 'Searching for more results…';
    if (key === 'plugin_result_score') return `${values?.count} of 5`;
    return key;
  },
}));

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
  useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS }, selectedEmail: null, externalSearchPending: [] });
  useAuthStore.setState({
    activeAccountId: 'login-1',
    getAllConnectedClients: () => new Map([['login-2', client('acc-2')], ['login-1', client('acc-1', ['group-1'])]]),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
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

  it('highlights what a snippet marks, its other text as text', () => {
    useEmailStore.setState({
      searchQuery: 'pixel grid',
      externalSearchResults: [{ ...result('crm', 'a', 'CRM'), snippet: 'The <mark>pixel grid</mark> is &lt;b&gt;coarse&lt;/b&gt;' }],
    });
    render(<PluginSearchResults surface="search-results" />);

    const mark = screen.getByText('pixel grid');
    expect(mark.tagName).toBe('MARK');
    expect(mark.parentElement).toHaveTextContent('The pixel grid is <b>coarse</b>');
    expect(mark.parentElement?.querySelector('b')).toBeNull();
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

  it('says nothing about a plugin that answers within the grace', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);

    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS - 1));
    act(() => useEmailStore.setState({ externalSearchPending: [] }));
    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));

    expect(container).toBeEmptyDOMElement();
  });

  it('holds the block\'s place with placeholder rows while a plugin takes longer, then fills it', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(container).toBeEmptyDOMElement();

    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));
    const waiting = screen.getByRole('region', { name: 'Searching for more results…' });
    expect(waiting).toHaveAttribute('aria-busy', 'true');
    const block = container.querySelector('[data-plugin-surface]');
    expect(block).toHaveClass('h-48');

    act(() => useEmailStore.setState({ externalSearchResults: [result('crm', 'a', 'CRM')], externalSearchPending: [] }));
    expect(screen.queryByRole('region', { name: 'Searching for more results…' })).toBeNull();
    expect(screen.getByRole('region', { name: 'CRM' })).toHaveTextContent('Title a');
    // The same height as while it waited: the list below does not move again.
    expect(container.querySelector('[data-plugin-surface]')).toHaveClass('h-48');
  });

  it('shows the entries of a plugin that answered beside the one still searching', () => {
    vi.useFakeTimers();
    useEmailStore.setState({
      searchQuery: 'resolution',
      externalSearchResults: [result('chat', 'b')],
      externalSearchPending: ['crm'],
    });
    render(<PluginSearchResults surface="search-results" />);
    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));

    expect(screen.getByRole('region', { name: 'Team chat' })).toHaveTextContent('Title b');
    expect(screen.getByRole('region', { name: 'Searching for more results…' })).toBeInTheDocument();
  });

  it('takes the place again at the next search', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ searchQuery: 'one', externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));
    act(() => useEmailStore.setState({ externalSearchResults: [result('crm', 'a', 'CRM')], externalSearchPending: [] }));

    // A search the plugin answers at once: the block as without waiting.
    act(() => useEmailStore.setState({ searchQuery: 'two', externalSearchResults: [], externalSearchPending: ['crm'] }));
    act(() => useEmailStore.setState({ externalSearchResults: [result('crm', 'c', 'CRM')], externalSearchPending: [] }));

    expect(container.querySelector('[data-plugin-surface]')).not.toHaveClass('h-48');
  });
});

// The block's lower edge drags (ResizeHandle): its share of the list's height,
// kept for later searches, the default again on a double click.
describe('PluginSearchResults height', () => {
  /** The list the block sits in is LIST px high, the block itself BLOCK px. */
  const LIST = 1000;
  const BLOCK = 200;

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(LIST);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(BLOCK);
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'a', 'CRM')] });
  });

  afterEach(() => vi.restoreAllMocks());

  const block = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-plugin-surface]')!;
  const handle = () => screen.getByRole('separator', { name: 'resize_plugin_results' });
  // The share as kept, never below MIN_HEIGHT whatever the list's height now.
  const capped = (share: string) => `max(${MIN_HEIGHT}px, ${share})`;

  it('takes the default share of the list until its edge is dragged', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(block(container).style.maxHeight).toBe(capped(`${DEFAULT_SHARE * 100}%`));
    expect(handle()).toHaveAttribute('aria-valuenow', String(BLOCK));
    expect(handle()).toHaveAttribute('aria-valuemin', String(MIN_HEIGHT));
    expect(handle()).toHaveAttribute('aria-valuemax', String(LIST * MAX_SHARE));
  });

  it('grows by the arrow keys from its height now and keeps the share', async () => {
    const { container, unmount } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    // The handle ends a key's step after it rendered, which is when the share is kept.
    await act(async () => {});
    // 200 px + one step of 10 px, of a list of 1000 px.
    expect(block(container).style.maxHeight).toBe(capped('21%'));
    unmount();

    const again = render(<PluginSearchResults surface="search-results" />);
    expect(block(again.container).style.maxHeight).toBe(capped('21%'));
  });

  it('follows a drag of its edge, within its limits', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 600, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped('50%'));

    fireEvent.pointerMove(document, { pointerId: 1, clientY: 2000, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped(`${MAX_SHARE * 100}%`));

    fireEvent.pointerMove(document, { pointerId: 1, clientY: 0, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped(`${(MIN_HEIGHT / LIST) * 100}%`));
    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it('takes the default again on a double click', () => {
    localStorage.setItem('pluginSearchResultsShare', '0.7');
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(block(container).style.maxHeight).toBe(capped('70%'));

    fireEvent.doubleClick(handle());
    expect(block(container).style.maxHeight).toBe(capped(`${DEFAULT_SHARE * 100}%`));
    expect(localStorage.getItem('pluginSearchResultsShare')).toBeNull();
  });

  it('keeps its least height when a share kept on a taller list is less on this one', () => {
    // Dragged to 64 px of a 1000 px list; this list is 500 px.
    localStorage.setItem('pluginSearchResultsShare', '0.064');
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(block(container).style.maxHeight).toBe(`max(${MIN_HEIGHT}px, 6.4%)`);
  });
});

// One line per entry, chosen at the first heading and kept: score, title,
// from and date in the row (only there), the snippet in its tooltip and
// under the entry whose message is open.
describe('PluginSearchResults compact rows', () => {
  const rich = (key: string, more: Partial<ProvidedSearchResult> = {}): ProvidedSearchResult => ({
    ...result('crm', key, 'CRM'), from: `Sender ${key}`, date: '2020-02-03T09:12:00Z', score: 0.6, snippet: 'An <mark>order</mark>', ...more,
  });

  beforeEach(() => {
    localStorage.clear();
    useEmailStore.setState({ searchQuery: 'order', externalSearchResults: [rich('a'), rich('b', { email: { id: 'M2' } })] });
  });

  const toggleButton = () => screen.getByRole('button', { name: 'compact_plugin_results' });

  it('shows title and snippet in an entry of two lines, as without from, date and score', () => {
    render(<PluginSearchResults surface="search-results" />);
    const entry = screen.getByRole('button', { name: /Title a/ });
    expect(entry).toHaveTextContent('An order');
    expect(entry).not.toHaveTextContent('Sender a');
    expect(screen.queryByRole('img', { name: '3 of 5' })).toBeNull();
    expect(toggleButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows one line per entry, the snippet in its tooltip, and keeps the choice', () => {
    const { unmount } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(toggleButton());

    const entry = screen.getByRole('button', { name: /Title a/ });
    expect(entry).toHaveTextContent('Sender a');
    expect(screen.getAllByRole('img', { name: '3 of 5' })).toHaveLength(2);
    expect(entry).not.toHaveTextContent('An order');
    expect(entry).toHaveAttribute('title', 'An order');
    expect(toggleButton()).toHaveAttribute('aria-pressed', 'true');
    unmount();

    render(<PluginSearchResults surface="search-results" />);
    expect(toggleButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the snippet under the compact entry whose message is open', () => {
    localStorage.setItem('pluginSearchResultsCompact', '1');
    useEmailStore.setState({ selectedEmail: { id: 'M2' } as Email });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.getByRole('button', { name: /Title b/ })).toHaveTextContent('An order');
    expect(screen.getByRole('button', { name: /Title a/ })).not.toHaveTextContent('An order');
  });

  it('offers the choice once, at the first heading', () => {
    useEmailStore.setState({ externalSearchResults: [rich('a'), result('chat', 'c')] });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.getAllByRole('button', { name: 'compact_plugin_results' })).toHaveLength(1);
  });
});
