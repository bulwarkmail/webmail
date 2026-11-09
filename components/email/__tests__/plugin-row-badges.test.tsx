import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { clearRowBadgeCache, normalizeBadges, MAX_ROW_BADGES } from '../plugin-row-badges';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { renderHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { refreshRowBadges, resetRowBadgeRefresh } from '@/lib/plugin-sandbox/row-badges';
import type { Email } from '@/lib/jmap/types';

// onEmailListItemRender: plugins add small badges next to a row's subject.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return {
    useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: any) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: 'email-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2024-01-15T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Test Subject',
  hasAttachment: false,
  ...overrides,
});

function row(emails: Email[]) {
  const [thread] = groupEmailsByThread(emails);
  return (
    <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
  );
}

beforeEach(() => {
  clearAllHooks();
  clearRowBadgeCache();
  resetRowBadgeRefresh();
  useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
  useSettingsStore.setState({
    emailKeywords: [...DEFAULT_KEYWORDS],
    showPreview: false,
    mailLayout: 'split',
    interfaceLayout: 'default',
  });
  useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
});

describe('plugin badges in message-list rows', () => {
  it('shows the badges a plugin returns, with the email as a plain summary', async () => {
    const handler = vi.fn(async (badges: unknown[]) => [
      ...badges,
      { key: 'enc', label: 'Encrypted', color: '#2563eb', title: 'Signed and encrypted' },
    ]);
    renderHooks.onEmailListItemRender.register('test', handler);

    render(row([makeEmail()]));

    const badge = await screen.findByText('Encrypted');
    expect(badge).toHaveAttribute('title', 'Signed and encrypted');
    expect(badge.style.borderColor).not.toBe('');
    expect(handler).toHaveBeenCalledTimes(1);
    const [initial, ctx] = handler.mock.calls[0] as unknown as [unknown, { email: Record<string, unknown> }];
    expect(initial).toEqual([]);
    expect(ctx.email).toMatchObject({ id: 'email-1', subject: 'Test Subject', keywords: ['$seen'] });
    // A projection, not the store object.
    expect(ctx.email).not.toHaveProperty('mailboxIds.inbox');
  });

  it('draws a badge\'s icon before its label, and none for a name that isn\'t one', async () => {
    renderHooks.onEmailListItemRender.register('test', async () => [
      { key: 'done', label: 'Done', icon: 'check' },
      { key: 'bad', label: 'Bad', icon: 'x"><script>' },
    ]);

    const { container } = render(row([makeEmail()]));

    await screen.findByText('Done');
    const done = container.querySelector('[data-plugin-row-badge="done"]')!;
    expect(done.querySelector('svg[data-badge-icon="check"]')).not.toBeNull();
    expect(done).toHaveTextContent('Done');
    expect(container.querySelector('[data-plugin-row-badge="bad"] svg')).toBeNull();
    expect(normalizeBadges([{ key: 'bad', label: 'Bad', icon: 'x"><script>' }])[0]).not.toHaveProperty('icon');
  });

  it('draws an icon-only badge, read out by its title', async () => {
    renderHooks.onEmailListItemRender.register('test', async () => [
      { key: 'fu-done', label: '', icon: 'flag-check', title: 'Follow-up done' },
    ]);

    const { container } = render(row([makeEmail()]));

    const badge = await screen.findByRole('img', { name: 'Follow-up done' });
    expect(badge).toHaveAttribute('data-plugin-row-badge', 'fu-done');
    expect(badge).toHaveTextContent('');
    expect(container.querySelector('[data-plugin-row-badge="fu-done"] svg')).not.toBeNull();
  });

  it('asks the plugin again when it requests a refresh, at most once a second', async () => {
    let label = 'Open';
    const handler = vi.fn(async () => [{ key: 'task', label }]);
    renderHooks.onEmailListItemRender.register('test', handler);
    render(row([makeEmail()]));
    await screen.findByText('Open');

    label = 'Done';
    act(() => { expect(refreshRowBadges(10_000)).toBe(true); });
    await screen.findByText('Done');
    expect(refreshRowBadges(10_500)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('shows badges on a conversation row and on the phone layout', async () => {
    useUIStore.setState({ isMobile: true, isCompact: false, isDesktop: false });
    renderHooks.onEmailListItemRender.register('test', async () => [{ key: 'k', label: 'Phone badge' }]);

    render(row([
      makeEmail({ id: 'a', receivedAt: '2024-01-15T10:00:00Z' }),
      makeEmail({ id: 'b', receivedAt: '2024-01-16T10:00:00Z' }),
    ]));

    expect(await screen.findByText('Phone badge')).toBeInTheDocument();
  });

  it('renders the label as text, never as HTML', async () => {
    renderHooks.onEmailListItemRender.register('test', async () => [
      { key: 'x', label: '<img src=x onerror=alert(1)>' },
    ]);

    const { container } = render(row([makeEmail()]));

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('asks plugins once per message and keyword state, not on every render', async () => {
    const handler = vi.fn(async () => [{ key: 'k', label: 'Badge' }]);
    renderHooks.onEmailListItemRender.register('test', handler);
    const email = makeEmail();

    const view = render(row([email]));
    await screen.findByText('Badge');
    view.rerender(row([{ ...email }]));
    view.unmount();
    render(row([{ ...email }]));
    await screen.findByText('Badge');
    expect(handler).toHaveBeenCalledTimes(1);

    // Marking it unread is a new keyword state: ask again.
    render(row([{ ...email, keywords: {} }]));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  });

  it('does nothing without a handler', async () => {
    const transform = vi.spyOn(renderHooks.onEmailListItemRender, 'transform');
    render(row([makeEmail()]));
    await act(async () => {});
    expect(transform).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-row-badges')).toBeNull();
    transform.mockRestore();
  });

  it('asks rows drawn before the plugin started once its handler arrives, and drops the badge when it goes', async () => {
    render(row([makeEmail()]));
    await act(async () => {});
    expect(screen.queryByTestId('plugin-row-badges')).toBeNull();
    let off: { dispose: () => void } = { dispose: () => {} };
    act(() => { off = renderHooks.onEmailListItemRender.register('e-invoice', () => [{ key: 'e', label: 'E-invoice' }]); });
    expect(await screen.findByText('E-invoice')).toBeInTheDocument();
    act(() => { off.dispose(); });
    await waitFor(() => expect(screen.queryByText('E-invoice')).toBeNull());
  });
});

describe('normalizeBadges', () => {
  it(`keeps at most ${MAX_ROW_BADGES} well-formed badges and drops unsafe colours`, () => {
    const out = normalizeBadges([
      { key: 'a', label: 'A', color: 'url(https://evil.example/x.png)' },
      { key: 'b', label: '' },
      'nonsense',
      { key: 'c', label: 'C', color: 'var(--color-warning)' },
      { key: 'd', label: 'D', color: 'red; background: url(x)' },
      { key: 'e', label: 'E' },
      { key: 'f', label: 'F' },
    ]);
    expect(out).toEqual([
      { key: 'a', label: 'A' },
      { key: 'c', label: 'C', color: 'var(--color-warning)' },
      { key: 'd', label: 'D' },
    ]);
    expect(normalizeBadges(undefined)).toEqual([]);
  });

  it('keeps a badge without a label only with an icon and a key', () => {
    expect(normalizeBadges([
      { key: 'i', label: '', icon: 'check', title: 'Done' },
      { key: 'n', label: '' },
      { label: '', icon: 'check' },
      { key: 'x', label: '', icon: 'x"><script>' },
    ])).toEqual([{ key: 'i', label: '', icon: 'check', title: 'Done' }]);
  });
});
