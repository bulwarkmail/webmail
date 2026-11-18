import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { setActionDispatcher } from '@/lib/plugin-sandbox/actions';
import type { ProvidedSearchResult } from '@/lib/plugin-search-results';
import type { Email } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_SHARE, MAX_SHARE, MIN_HEIGHT, PENDING_GRACE_MS, PluginSearchResults, SNAP_PX, WHOLE_SLACK_PX } from '../plugin-search-results';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'more_results_searching') return 'Searching for more results…';
    if (key === 'plugin_result_score') return `${values?.count} of 5`;
    if (key === 'collapse' || key === 'expand') return `${key} ${JSON.stringify(values)}`;
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

  it('folds a group by its chevron when several plugins answered', () => {
    useEmailStore.setState({
      searchQuery: 'resolution',
      externalSearchResults: [result('crm', 'a', 'CRM'), result('chat', 'b')],
    });
    render(<PluginSearchResults surface="search-results" />);

    const chevron = within(screen.getByRole('region', { name: 'CRM' })).getByRole('button', { name: 'collapse {"name":"CRM"}' });
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chevron);

    expect(screen.queryByText('Title a')).toBeNull();
    expect(screen.getByText('Title b')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'expand {"name":"CRM"}' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no fold for the one group of a single plugin', () => {
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'a', 'CRM')] });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.queryByRole('button', { name: /^(collapse|expand) / })).toBeNull();
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

  it('holds the block\'s place at its share with placeholder rows while a plugin takes longer, then fills it', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(container).toBeEmptyDOMElement();

    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));
    const waiting = screen.getByRole('region', { name: 'Searching for more results…' });
    expect(waiting).toHaveAttribute('aria-busy', 'true');
    const block = container.querySelector<HTMLElement>('[data-plugin-surface]')!;
    const share = `max(${MIN_HEIGHT}px, ${DEFAULT_SHARE * 100}%)`;
    expect(block.style.height).toBe(share);

    act(() => useEmailStore.setState({ externalSearchResults: [result('crm', 'a', 'CRM')], externalSearchPending: [] }));
    expect(screen.queryByRole('region', { name: 'Searching for more results…' })).toBeNull();
    expect(screen.getByRole('region', { name: 'CRM' })).toHaveTextContent('Title a');
    // The share is now the most it takes, and no height of its own is left
    // that a drag of its edge could not get past.
    expect(block.style.height).toBe('');
    expect(block.style.maxHeight).toBe(share);
    expect(block).not.toHaveClass('h-48');
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

    expect(container.querySelector<HTMLElement>('[data-plugin-surface]')!.style.height).toBe('');
  });
});

// The search as two sections: the plugins' results under their heading, the
// messages under theirs, in the row that is also the edge to drag. A click on
// a heading gives its section the whole height, a second one the shares back.
describe('PluginSearchResults sections', () => {
  const LIST = 1000;
  let blockHeight = 200;
  let entriesHeight = 0;

  beforeEach(() => {
    localStorage.clear();
    blockHeight = 200;
    entriesHeight = 0;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(LIST);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => blockHeight);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => entriesHeight);
    useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'a', 'CRM')] });
  });

  afterEach(() => vi.restoreAllMocks());

  const block = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-plugin-surface]')!;
  const capped = (share: string) => `max(${MIN_HEIGHT}px, ${share})`;
  const handle = () => screen.getByRole('separator', { name: 'resize_plugin_results' });
  const messages = () => screen.getByRole('button', { name: 'listbox_label' });
  const heading = () => screen.getByRole('button', { name: /^CRM/ });
  const drag = (from: number, to: number) => {
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: from });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: to, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
  };

  it('heads the messages only while plugins have results', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(messages()).toHaveAttribute('aria-pressed', 'false');

    act(() => useEmailStore.setState({ externalSearchResults: [] }));
    expect(container).toBeEmptyDOMElement();
  });

  it('shares the list half and half until the edge is dragged', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    expect(DEFAULT_SHARE).toBe(0.5);
    expect(block(container).style.maxHeight).toBe(capped('50%'));
  });

  it('gives the plugins\' results the whole height on a click on their heading, the shares back on the next', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(heading());
    expect(heading()).toHaveAttribute('aria-pressed', 'true');
    // No share caps the block, and it may shrink to what the list has.
    expect(block(container).style.maxHeight).toBe('');
    expect(block(container)).toHaveClass('shrink', 'min-h-0');
    expect(screen.getByText('Title a')).toBeInTheDocument();

    fireEvent.click(heading());
    expect(heading()).toHaveAttribute('aria-pressed', 'false');
    expect(block(container).style.maxHeight).toBe(capped('50%'));
    expect(block(container)).toHaveClass('flex-shrink-0');
  });

  it('gives the messages the whole height on a click on their heading: the results down to their heading', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    expect(messages()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Title a')).toBeNull();
    expect(heading()).toBeInTheDocument();
    expect(block(container).style.maxHeight).toBe('');

    fireEvent.click(messages());
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Title a')).toBeInTheDocument();
    expect(block(container).style.maxHeight).toBe(capped('50%'));
  });

  it('goes from one section\'s whole height straight to the other\'s', () => {
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    fireEvent.click(heading());
    expect(heading()).toHaveAttribute('aria-pressed', 'true');
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Title a')).toBeInTheDocument();

    fireEvent.click(messages());
    expect(heading()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Title a')).toBeNull();
  });

  it('starts the next search with the shares, and keeps nothing of the whole height', () => {
    const { unmount } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    expect(localStorage.length).toBe(0);

    act(() => useEmailStore.setState({ searchQuery: 'budget', externalSearchResults: [result('crm', 'b', 'CRM')] }));
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Title b')).toBeInTheDocument();
    unmount();

    render(<PluginSearchResults surface="search-results" />);
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts the same search with the shares when it is run again after it was left', () => {
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());

    act(() => useEmailStore.setState({ searchQuery: '', externalSearchResults: [] }));
    act(() => useEmailStore.setState({ searchQuery: 'resolution', externalSearchResults: [result('crm', 'a', 'CRM')] }));
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Title a')).toBeInTheDocument();
  });

  it('starts a search by other filters with the shares, the query the same', () => {
    useEmailStore.setState({ searchQuery: '', searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'bob@x.test' } });
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    expect(messages()).toHaveAttribute('aria-pressed', 'true');

    act(() => useEmailStore.setState({ searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'eve@x.test' } }));
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the whole height and the share through a slip of the hand on the handle, and a key outward', async () => {
    localStorage.setItem('pluginSearchResultsShare', '0.6');
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    blockHeight = 30;
    drag(30, 30 + WHOLE_SLACK_PX - 1);
    drag(30, 0);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    await act(async () => {});
    expect(messages()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.600');

    fireEvent.click(heading());
    blockHeight = 950;
    drag(950, 950 - WHOLE_SLACK_PX + 1);
    drag(950, 990);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    await act(async () => {});
    expect(heading()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.600');
  });

  it('says the results have the whole height only while they do: not while another plugin is waited for', () => {
    vi.useFakeTimers();
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(heading());
    act(() => useEmailStore.setState({ externalSearchPending: ['chat'] }));
    act(() => { vi.advanceTimersByTime(PENDING_GRACE_MS); });
    expect(block(container).style.height).toBe(capped('50%'));
    expect(heading()).toHaveAttribute('aria-pressed', 'false');

    act(() => useEmailStore.setState({ externalSearchPending: [] }));
    expect(heading()).toHaveAttribute('aria-pressed', 'true');
  });

  it('ends the whole height with a drag that follows the pointer from the first move', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(heading());
    // With the whole height the block is 950 px of the 1000 px list.
    blockHeight = 950;
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 950 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 946, buttons: 1 });
    // From the most a share gives (850 px), not from 950: four pixels up, no jump.
    expect(block(container).style.maxHeight).toBe(capped('84.6%'));
    expect(heading()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it('opens the results again with a drag down from the messages\' whole height, however short', () => {
    localStorage.setItem('pluginSearchResultsShare', '0.4');
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    // Down to its heading the block is 30 px high, and shows no entries to measure.
    blockHeight = 30;
    entriesHeight = 30;
    drag(30, 130);
    expect(messages()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Title a')).toBeInTheDocument();
    expect(block(container).style.maxHeight).toBe(capped('13%'));
  });

  it('snaps a drag to half the list, from below and from above', () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 500 - SNAP_PX, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped('50%'));
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 500 - SNAP_PX - 1, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped(`${50 - (SNAP_PX + 1) / 10}%`));
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 500 + SNAP_PX, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped('50%'));
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 500 + SNAP_PX + 1, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped(`${50 + (SNAP_PX + 1) / 10}%`));
    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it('gets past half with the arrow keys', async () => {
    const { container } = render(<PluginSearchResults surface="search-results" />);
    blockHeight = 495;
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    await act(async () => {});
    // 505 px is within the snap: half.
    expect(block(container).style.maxHeight).toBe(capped('50%'));
    blockHeight = 500;
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    await act(async () => {});
    expect(block(container).style.maxHeight).toBe(capped('51%'));
  });

  it('takes the default share again on a double click of the handle', () => {
    localStorage.setItem('pluginSearchResultsShare', '0.7');
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(heading());
    fireEvent.doubleClick(handle());
    expect(block(container).style.maxHeight).toBe(capped('50%'));
    expect(heading()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('pluginSearchResultsShare')).toBeNull();
  });

  it('keeps the handle\'s value within its limits whatever height the block has', () => {
    render(<PluginSearchResults surface="search-results" />);
    blockHeight = 30;
    fireEvent.click(messages());
    expect(Number(handle().getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(MIN_HEIGHT);
  });

  it('keeps the chevrons away while the messages have the whole height', () => {
    useEmailStore.setState({ externalSearchResults: [result('crm', 'a', 'CRM'), result('chat', 'b')] });
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.click(messages());
    expect(screen.queryByRole('button', { name: /^(collapse|expand) / })).toBeNull();
    expect(screen.queryByText('Title b')).toBeNull();
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

  it('follows a drag down and up after a plugin that took longer answered', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));
    act(() => useEmailStore.setState({ externalSearchResults: [result('crm', 'a', 'CRM')], externalSearchPending: [] }));

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 700, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped('70%'));
    expect(block(container).style.height).toBe('');

    fireEvent.pointerMove(document, { pointerId: 1, clientY: 100, buttons: 1 });
    expect(block(container).style.maxHeight).toBe(capped('10%'));
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.100');
  });

  it('follows a drag while it still waits, as its height', () => {
    vi.useFakeTimers();
    useEmailStore.setState({ externalSearchResults: [], externalSearchPending: ['crm'] });
    const { container } = render(<PluginSearchResults surface="search-results" />);
    act(() => vi.advanceTimersByTime(PENDING_GRACE_MS));

    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 500, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(block(container).style.height).toBe(capped('50%'));
  });

  it('grows no further than its entries need, and keeps that', () => {
    // Its entries are 300 px high and it had 20 % of the list: the edge stops at 300 px.
    localStorage.setItem('pluginSearchResultsShare', '0.2');
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 800, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(block(container).style.maxHeight).toBe(capped('30%'));
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.300');
  });

  it('keeps a larger share when a search with few results is dragged down', () => {
    // Two entries, 120 px, in a block that may take 60 %: nothing to grow into.
    localStorage.setItem('pluginSearchResultsShare', '0.6');
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 120 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 170, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(block(container).style.maxHeight).toBe(capped('60%'));
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.600');
  });

  it('keeps a larger share when a drag on a search with few results comes back to where it began', () => {
    localStorage.setItem('pluginSearchResultsShare', '0.6');
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 120 });
    // Sideways only, then down and back: the edge never left the entries' end.
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 120, clientX: 40, buttons: 1 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 150, buttons: 1 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 120, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.600');
  });

  it('keeps a larger share when a search with few results gets an arrow key', async () => {
    localStorage.setItem('pluginSearchResultsShare', '0.6');
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    render(<PluginSearchResults surface="search-results" />);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    await act(async () => {});
    expect(localStorage.getItem('pluginSearchResultsShare')).toBe('0.600');
  });

  it('shrinks below its entries when dragged up', () => {
    localStorage.setItem('pluginSearchResultsShare', '0.6');
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    const { container } = render(<PluginSearchResults surface="search-results" />);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(document, { pointerId: 1, clientY: 200, buttons: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(block(container).style.maxHeight).toBe(capped('20%'));
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

  it('shows the date as the message list does, in the time format the user chose', () => {
    localStorage.setItem('pluginSearchResultsCompact', '1');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 12).toISOString();
    useEmailStore.setState({ externalSearchResults: [rich('a', { date: today })] });

    useSettingsStore.setState({ timeFormat: '12h' });
    const { unmount } = render(<PluginSearchResults surface="search-results" />);
    expect(screen.getByRole('button', { name: /Title a/ })).toHaveTextContent(/03:12\s?PM/);
    unmount();

    useSettingsStore.setState({ timeFormat: '24h' });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.getByRole('button', { name: /Title a/ })).toHaveTextContent('15:12');
  });

  it('offers the choice once, at the first heading', () => {
    useEmailStore.setState({ externalSearchResults: [rich('a'), result('chat', 'c')] });
    render(<PluginSearchResults surface="search-results" />);
    expect(screen.getAllByRole('button', { name: 'compact_plugin_results' })).toHaveLength(1);
  });
});
