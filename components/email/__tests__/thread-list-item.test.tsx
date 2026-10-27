import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { emailKeyFor, groupEmailsByThread } from '@/lib/thread-utils';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null };
  return {
    useAuthStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

const ACCOUNT_TEAL = { id: 'acct-teal', avatarColor: '#0d9488', label: 'Teal account' };
const accountState = {
  getAccountById: (id: string) => (id === ACCOUNT_TEAL.id ? ACCOUNT_TEAL : undefined),
};
vi.mock('@/stores/account-store', () => ({
  useAccountStore: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (selector: any) => (selector ? selector(accountState) : accountState),
    { getState: () => accountState },
  ),
}));

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

/**
 * A one-message thread, built through the real grouping so the fixture cannot
 * drift from what the list actually feeds this component. `ThreadListItem`
 * delegates to `SingleEmailItem` at that size, which is what draws every
 * single-message row in the app.
 */
function renderRow(email: Email) {
  const [thread] = groupEmailsByThread([email]);
  return render(
    <ThreadListItem
      thread={thread}
      isExpanded={false}
      onToggleExpand={() => {}}
      onEmailSelect={() => {}}
    />,
  );
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
});

describe('ThreadListItem tag badge', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
    });
  });

  it('does not show a tag badge when the email has no label keyword', () => {
    renderRow(makeEmail({ keywords: { $seen: true } }));

    expect(screen.getByText('Test Subject')).toBeInTheDocument();
    DEFAULT_KEYWORDS.forEach((kw) => {
      expect(screen.queryByText(kw.label)).not.toBeInTheDocument();
    });
  });

  it('shows a tag badge for a $label: keyword', () => {
    renderRow(makeEmail({ keywords: { $seen: true, '$label:red': true } }));

    expect(screen.getByText('Red')).toBeInTheDocument();
  });

  it('shows a tag badge for the legacy $color: keyword', () => {
    renderRow(makeEmail({ keywords: { $seen: true, '$color:blue': true } }));

    expect(screen.getByText('Blue')).toBeInTheDocument();
  });

  it('falls back to the raw id when the tag is not in settings', () => {
    // A keyword created by another client, or one whose definition was deleted.
    renderRow(makeEmail({ keywords: { $seen: true, '$label:unknown-tag': true } }));

    expect(screen.getByText('unknown-tag')).toBeInTheDocument();
  });

  it('shows a custom tag label', () => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS, { id: 'work', label: 'Work', color: 'teal' }],
    });
    renderRow(makeEmail({ keywords: { $seen: true, '$label:work': true } }));

    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('follows a renamed tag definition', () => {
    const email = makeEmail({ keywords: { $seen: true, '$label:red': true } });
    const { rerender } = renderRow(email);
    expect(screen.getByText('Red')).toBeInTheDocument();

    act(() => {
      useSettingsStore.getState().updateKeyword('red', { label: 'Urgent' });
    });
    const [thread] = groupEmailsByThread([email]);
    rerender(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />,
    );

    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByText('Red')).not.toBeInTheDocument();
  });
});

describe('ThreadListItem multi-message thread', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
    });
  });

  function renderThread(emails: Email[], expanded = false) {
    const [thread] = groupEmailsByThread(emails);
    return render(
      <ThreadListItem
        thread={thread}
        isExpanded={expanded}
        expandedEmails={expanded ? emails : undefined}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
      />,
    );
  }

  it('carries the tags of every message, not just the first', () => {
    // A collapsed row stands in for the whole thread, so a tag applied only to
    // a later message still has to surface.
    renderThread([
      makeEmail({ id: 'e1', threadId: 't1', keywords: { '$label:red': true } }),
      makeEmail({ id: 'e2', threadId: 't1', keywords: { '$label:blue': true } }),
    ]);

    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
  });

  it('names a tag shared by several messages once', () => {
    renderThread([
      makeEmail({ id: 'e1', threadId: 't1', keywords: { '$label:red': true } }),
      makeEmail({ id: 'e2', threadId: 't1', keywords: { '$label:red': true } }),
    ]);

    expect(screen.getAllByText('Red')).toHaveLength(1);
  });

  it('shows each message its own tags once the thread is expanded', () => {
    renderThread(
      [
        makeEmail({ id: 'e1', threadId: 't1', keywords: { '$label:red': true } }),
        makeEmail({ id: 'e2', threadId: 't1', keywords: { '$label:blue': true } }),
      ],
      true,
    );

    // Once on the header and once on the message that carries it.
    expect(screen.getAllByText('Red').length).toBeGreaterThan(1);
  });
});

describe('ThreadListItem row content', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
    });
  });

  it('renders the subject without a tag', () => {
    renderRow(makeEmail({ subject: 'Hello World' }));

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders preview text inline in the focused layout', () => {
    useSettingsStore.setState({ showPreview: true, mailLayout: 'focus' });
    const { container } = renderRow(makeEmail({ preview: 'Inline preview content' }));

    expect(screen.getByText('Test Subject')).toBeInTheDocument();
    expect(screen.getByText(/Inline preview content/)).toBeInTheDocument();
    // Focused rows are one line: the preview shares the subject's element
    // rather than getting a paragraph of its own.
    expect(container.querySelector('p')).toBeNull();
  });

  it('puts the star at the trailing edge in the Mountain View phone row', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', mailLayout: 'split' });
    useUIStore.setState({ isMobile: true, isTablet: false, isDesktop: false });
    const onToggleStar = vi.fn();
    const [thread] = groupEmailsByThread([makeEmail()]);
    const { container } = render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
        onToggleStar={onToggleStar}
      />,
    );

    const star = container.querySelector<HTMLButtonElement>('[data-mv-mobile-row] button[aria-pressed]');
    expect(star).not.toBeNull();
    fireEvent.click(star!);

    expect(onToggleStar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-mv-mobile-row]')).toBeInTheDocument();
  });
});

describe('ThreadListItem opening a thread on the phone', () => {
  const twoMessageThread = () => groupEmailsByThread([
    makeEmail({ id: 'older', receivedAt: '2024-01-14T10:00:00Z' }),
    makeEmail({ id: 'newer', receivedAt: '2024-01-15T10:00:00Z' }),
  ])[0];

  function tap(interfaceLayout: 'mountain-view' | 'default') {
    useSettingsStore.setState({ interfaceLayout, mailLayout: 'split' });
    useUIStore.setState({ isMobile: true, isTablet: false, isDesktop: false });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
    const onEmailSelect = vi.fn();
    const onOpenConversation = vi.fn();
    render(
      <ThreadListItem
        thread={twoMessageThread()}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={onEmailSelect}
        onOpenConversation={onOpenConversation}
      />,
    );
    fireEvent.click(screen.getByText('Test Subject'));
    return { onEmailSelect, onOpenConversation };
  }

  // #1224: the phone thread view lists newest first and has no details, so
  // Mountain View opens the thread in the viewer, as on the desktop.
  it('opens the latest message in the viewer in Mountain View', () => {
    const { onEmailSelect, onOpenConversation } = tap('mountain-view');
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(onEmailSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'newer' }));
  });

  it('keeps the phone thread view in the default layout', () => {
    const { onEmailSelect, onOpenConversation } = tap('default');
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(onEmailSelect).not.toHaveBeenCalled();
  });
});

// #1231: opening a message threw away the ticked rows. Mountain View on the
// desktop keeps them, as Gmail does, so selecting can carry on after reading.
describe('ThreadListItem keeping the selection when a message opens', () => {
  function open(interfaceLayout: 'mountain-view' | 'default', emails: Email[]) {
    useSettingsStore.setState({ interfaceLayout, mailLayout: 'split' });
    useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
    useEmailStore.setState({ selectedEmailKeys: new Set(['other']), selectedMailbox: 'inbox' });
    const onEmailSelect = vi.fn();
    const [thread] = groupEmailsByThread(emails);
    render(
      <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={onEmailSelect} />,
    );
    fireEvent.click(screen.getByText('Test Subject'));
    return onEmailSelect;
  }
  const conversation = () => [
    makeEmail({ id: 'older', receivedAt: '2024-01-14T10:00:00Z' }),
    makeEmail({ id: 'newer', receivedAt: '2024-01-15T10:00:00Z' }),
  ];

  it('keeps the ticked rows when a Mountain View message opens', () => {
    const onEmailSelect = open('mountain-view', [makeEmail()]);
    expect(onEmailSelect).toHaveBeenCalledTimes(1);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['other']);
  });

  it('keeps them when a Mountain View conversation opens', () => {
    const onEmailSelect = open('mountain-view', conversation());
    expect(onEmailSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'newer' }));
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['other']);
  });
});

// #1014: once something is ticked, a click anywhere on the row ticks it
// instead of opening the message and dropping the selection.
describe('ThreadListItem whole row toggles in selection mode', () => {
  const conversation = () => [
    makeEmail({ id: 'older', receivedAt: '2024-01-14T10:00:00Z' }),
    makeEmail({ id: 'newer', receivedAt: '2024-01-15T10:00:00Z' }),
  ];

  function setup(
    emails: Email[],
    { layout = 'default', mobile = false, selected = ['other'], isExpanded = false }: {
      layout?: 'mountain-view' | 'default'; mobile?: boolean; selected?: string[]; isExpanded?: boolean;
    } = {},
  ) {
    useSettingsStore.setState({ interfaceLayout: layout, mailLayout: 'split', density: 'regular' } as never);
    useUIStore.setState({ isMobile: mobile, isTablet: false, isDesktop: !mobile });
    useEmailStore.setState({ selectedEmailKeys: new Set(selected), selectedMailbox: 'inbox' });
    const onEmailSelect = vi.fn();
    const onEmailDoubleClick = vi.fn();
    const onOpenConversation = vi.fn();
    const onToggleExpand = vi.fn();
    const [thread] = groupEmailsByThread(emails);
    const utils = render(
      <ThreadListItem
        thread={thread}
        isExpanded={isExpanded}
        expandedEmails={isExpanded ? thread.emails : undefined}
        onToggleExpand={onToggleExpand}
        onEmailSelect={onEmailSelect}
        onEmailDoubleClick={onEmailDoubleClick}
        onOpenConversation={onOpenConversation}
      />,
    );
    return { ...utils, onEmailSelect, onEmailDoubleClick, onOpenConversation, onToggleExpand };
  }
  const selection = () => [...useEmailStore.getState().selectedEmailKeys].sort();

  it('ticks a message row instead of opening it', () => {
    const { onEmailSelect } = setup([makeEmail()]);
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(selection()).toEqual(['email-1', 'other']);
  });

  it('unticks it on the next click', () => {
    const { onEmailSelect } = setup([makeEmail()], { selected: ['email-1', 'other'] });
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(selection()).toEqual(['other']);
  });

  it('opens the message as before when nothing is ticked', () => {
    const { onEmailSelect } = setup([makeEmail()], { selected: [] });
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).toHaveBeenCalledTimes(1);
    expect(selection()).toEqual([]);
  });

  it('does not open the message on a double click', () => {
    const { onEmailDoubleClick } = setup([makeEmail()]);
    fireEvent.doubleClick(screen.getByText('Test Subject'));
    expect(onEmailDoubleClick).not.toHaveBeenCalled();
  });

  it('ticks every message of a thread row without unfolding it', () => {
    const { onEmailSelect, onToggleExpand } = setup(conversation());
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(onToggleExpand).not.toHaveBeenCalled();
    expect(selection()).toEqual(['newer', 'older', 'other']);
  });

  it('still unfolds the thread from its chevron', () => {
    const { container, onToggleExpand } = setup(conversation());
    fireEvent.click(container.querySelector('[data-expand-toggle]')!);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    expect(selection()).toEqual(['other']);
  });

  it('ticks a thread on the phone instead of opening the thread view', () => {
    const { onOpenConversation, onEmailSelect } = setup(conversation(), { mobile: true });
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(selection()).toEqual(['newer', 'older', 'other']);
  });

  it('ticks a Mountain View phone row', () => {
    const { onEmailSelect } = setup([makeEmail()], { layout: 'mountain-view', mobile: true });
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(selection()).toEqual(['email-1', 'other']);
  });

  it('ticks a message inside an unfolded thread', () => {
    const { onEmailSelect } = setup(conversation(), { isExpanded: true });
    // The unfolded messages show the sender; the header shows the subject.
    const older = screen.getAllByText('Alice').find((el) => el.closest('.ps-12'))!;
    fireEvent.click(older);
    expect(onEmailSelect).not.toHaveBeenCalled();
    expect(selection().filter((k) => k !== 'other')).toHaveLength(1);
  });
});

describe('ThreadListItem Mountain View phone row layout', () => {
  it('sets the star at the end of the preview line, not under the time', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', mailLayout: 'split', showPreview: true, density: 'regular' } as never);
    useUIStore.setState({ isMobile: true, isTablet: false, isDesktop: false });
    const [thread] = groupEmailsByThread([makeEmail()]);
    const { container } = render(
      <ThreadListItem
        thread={thread}
        isExpanded={false}
        onToggleExpand={() => {}}
        onEmailSelect={() => {}}
        onToggleStar={() => {}}
      />,
    );

    const stars = container.querySelectorAll('[data-mv-mobile-row] button[aria-pressed]');
    expect(stars).toHaveLength(1);
    // Same line as the preview text: snippet ... star.
    expect(stars[0].parentElement?.querySelector('p')).not.toBeNull();
  });
});

describe('ThreadListItem shift-range avatar selection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
    });
  });

  it('shift-clicking the avatar extends the selection from the anchor', () => {
    const e1 = makeEmail({ id: 'e1', threadId: 't1' });
    const e2 = makeEmail({ id: 'e2', threadId: 't2' });
    const e3 = makeEmail({ id: 'e3', threadId: 't3' });
    // Selection mode active, with the anchor on e1.
    useEmailStore.setState({
      emails: [e1, e2, e3],
      selectedEmailKeys: new Set(['e1']),
      lastSelectedEmailKey: 'e1',
      selectedMailbox: 'inbox',
    });

    renderRow(e3);
    const avatar = screen.getByRole('checkbox');
    act(() => {
      avatar.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });

    const selected = useEmailStore.getState().selectedEmailKeys;
    expect(selected.has('e1')).toBe(true);
    expect(selected.has('e2')).toBe(true); // the row in between got filled in
    expect(selected.has('e3')).toBe(true);
  });
});

describe('ThreadListItem row tint', () => {
  const rowClasses = (container: HTMLElement) =>
    container.querySelector('[data-email-id="email-1"]')!.className.split(' ');

  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
      tintListRowsByTag: true,
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set(['email-1']),
      selectedMailbox: 'inbox',
    });
  });

  it('keeps a checked row tinted, and says so to either theme', () => {
    const { container } = renderRow(makeEmail({ keywords: { $seen: true, '$label:red': true } }));
    const classes = rowClasses(container);

    expect(classes).toContain('bg-red-50');
    expect(classes).toContain('dark:bg-red-950/30');
    expect(classes).not.toContain('bg-accent/40');
    expect(classes).toContain('ring-primary/20');
  });

  it('washes a checked row that has no tint to keep', () => {
    const { container } = renderRow(makeEmail({ keywords: { $seen: true } }));
    const classes = rowClasses(container);

    expect(classes).toContain('bg-accent/40');
    expect(classes).toContain('ring-primary/20');
  });

  it('leaves the tint alone when the setting is off', () => {
    useSettingsStore.setState({ tintListRowsByTag: false });
    const { container } = renderRow(makeEmail({ keywords: { $seen: true, '$label:red': true } }));
    const classes = rowClasses(container);

    expect(classes).not.toContain('bg-red-50');
    expect(classes).toContain('bg-accent/40');
  });
});


describe('ThreadListItem account row tint', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
      tintListRowsByTag: true,
      tintListRowsByAccount: false,
    });
    useEmailStore.setState({
      selectedEmailKeys: new Set<string>(),
      selectedMailbox: 'inbox',
      isUnifiedView: false,
    });
  });

  const row = (c: HTMLElement) => c.querySelector('[data-subject="Test Subject"]');
  const accountEmail = () => makeEmail({ accountId: ACCOUNT_TEAL.id, accountLabel: ACCOUNT_TEAL.label });

  it('tints the row with the account colour in the unified view', () => {
    useSettingsStore.setState({ tintListRowsByAccount: true });
    useEmailStore.setState({ isUnifiedView: true });

    const { container } = renderRow(accountEmail());
    expect(row(container)!.className).toContain('bg-teal-100');
  });

  it('leaves rows untinted outside the unified view', () => {
    useSettingsStore.setState({ tintListRowsByAccount: true });
    useEmailStore.setState({ isUnifiedView: false });

    const { container } = renderRow(accountEmail());
    expect(row(container)!.className).not.toContain('bg-teal-100');
  });

  it('does not tint by account while the setting is off', () => {
    useEmailStore.setState({ isUnifiedView: true });

    const { container } = renderRow(accountEmail());
    expect(row(container)!.className).not.toContain('bg-teal-100');
  });

  it('still tints when accountId matches no local account', () => {
    // Shared/group entries carry the JMAP owner id, which no AccountEntry
    // matches - the row must fall back to a colour from the label, not stay blank.
    useSettingsStore.setState({ tintListRowsByAccount: true });
    useEmailStore.setState({ isUnifiedView: true });
    const orphan = makeEmail({ accountId: 'jmap-owner-id-with-no-entry', accountLabel: 'luca@lucazanon.it' });

    const { container } = renderRow(orphan);
    expect(row(container)!.className).toMatch(/bg-[a-z]+-\d+/);
  });

  it('gives different accounts different tints', () => {
    useSettingsStore.setState({ tintListRowsByAccount: true });
    useEmailStore.setState({ isUnifiedView: true });

    const a = renderRow(makeEmail({ accountId: 'x', accountLabel: 'luca@insulaab.it' }));
    const clsA = row(a.container)!.className.match(/bg-[a-z]+-\d+/)![0];
    a.unmount();
    const b = renderRow(makeEmail({ accountId: 'y', accountLabel: 'luca@lucazanon.it' }));
    const clsB = row(b.container)!.className.match(/bg-[a-z]+-\d+/)![0];

    expect(clsA).not.toBe(clsB);
  });

  it('outranks the tag tint', () => {
    useSettingsStore.setState({ tintListRowsByAccount: true });
    useEmailStore.setState({ isUnifiedView: true });
    const tagged = makeEmail({
      accountId: ACCOUNT_TEAL.id,
      keywords: { $seen: true, [`$label:${DEFAULT_KEYWORDS[0].id}`]: true },
    });

    const { container } = renderRow(tagged);
    expect(row(container)!.className).toContain('bg-teal-100');
  });
});

describe('ThreadListItem selection in a merged view', () => {
  // Unified and tag views stamp each email with its owning account, and the
  // selection holds `emailKeyFor` keys. A bare-id check never matches them.
  const stamp = { sourceClientAccountId: 'account-b', sourceAccountId: 'account-b' };

  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      density: 'regular',
    });
    useEmailStore.setState({
      isUnifiedView: true,
      selectedEmailKeys: new Set<string>(),
      lastSelectedEmailKey: null,
      selectedMailbox: '',
    });
  });

  it('shows a ticked stamped row as checked', () => {
    const email = makeEmail({ ...stamp });
    useEmailStore.setState({ emails: [email], selectedEmailKeys: new Set([emailKeyFor(email)]) });
    renderRow(email);

    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('does not show a namesake row from another account as checked', () => {
    const mine = makeEmail({ sourceClientAccountId: 'account-a', sourceAccountId: 'account-a' });
    const theirs = makeEmail({ ...stamp });
    useEmailStore.setState({ emails: [mine, theirs], selectedEmailKeys: new Set([emailKeyFor(mine)]) });
    renderRow(theirs);

    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  });

  it('ticks a whole thread by key and shows it checked', () => {
    const e1 = makeEmail({ id: 'e1', threadId: 't1', receivedAt: '2024-01-15T10:00:00Z', ...stamp });
    const e2 = makeEmail({ id: 'e2', threadId: 't1', receivedAt: '2024-01-15T11:00:00Z', ...stamp });
    useEmailStore.setState({ emails: [e1, e2] });
    const [thread] = groupEmailsByThread([e1, e2]);
    const ui = (
      <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />
    );
    const { rerender } = render(ui);

    act(() => {
      screen.getByRole('checkbox').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const { selectedEmailKeys, lastSelectedEmailKey } = useEmailStore.getState();
    expect([...selectedEmailKeys].sort()).toEqual([emailKeyFor(e1), emailKeyFor(e2)].sort());
    expect(lastSelectedEmailKey).toBe(emailKeyFor(e2));
    rerender(ui);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

    act(() => {
      screen.getByRole('checkbox').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
  });
});

describe('ThreadListItem Mountain View desktop row', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: true,
      mailLayout: 'focus',
      interfaceLayout: 'mountain-view',
    } as never);
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
  });

  it('runs the snippet on from the subject after a dash', () => {
    const { container } = renderRow(makeEmail({ preview: 'See you there' }));
    expect(container.textContent).toContain('Test Subject - See you there');
  });

  it('counts a thread after the names instead of in a pill, and opens it without unfolding', () => {
    const onEmailSelect = vi.fn();
    const onToggleExpand = vi.fn();
    const emails = [
      makeEmail({ id: 'a', receivedAt: '2024-01-15T10:00:00Z' }),
      makeEmail({ id: 'b', receivedAt: '2024-01-15T11:00:00Z', from: [{ name: 'Bob', email: 'bob@example.com' }] }),
    ];
    const [thread] = groupEmailsByThread(emails);
    const { container } = render(
      <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={onToggleExpand} onEmailSelect={onEmailSelect} />,
    );

    const names = container.querySelector('[data-mv-names]');
    expect(names?.textContent).toMatch(/2$/);
    fireEvent.click(screen.getByText('Test Subject'));
    expect(onEmailSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(onToggleExpand).not.toHaveBeenCalled();
  });
});

describe('ThreadListItem prefetch on mouse press', () => {
  const renderWithPrefetch = (onPrefetch: (email: Email) => void) => {
    const [thread] = groupEmailsByThread([makeEmail()]);
    return render(
      <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onPrefetch={onPrefetch} />,
    );
  };

  it('asks for the message when a mouse is pressed on the row', () => {
    const onPrefetch = vi.fn();
    renderWithPrefetch(onPrefetch);
    fireEvent.pointerDown(screen.getByTestId('email-list-item'), { pointerType: 'mouse', button: 0 });
    expect(onPrefetch).toHaveBeenCalledWith(expect.objectContaining({ id: 'email-1' }));
  });

  it('leaves touches, other buttons and presses on controls in the row alone', () => {
    const onPrefetch = vi.fn();
    renderWithPrefetch(onPrefetch);
    const row = screen.getByTestId('email-list-item');
    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0 });
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 2 });
    fireEvent.pointerEnter(row);
    const control = row.querySelector('button');
    expect(control).not.toBeNull();
    fireEvent.pointerDown(control!, { pointerType: 'mouse', button: 0 });
    expect(onPrefetch).not.toHaveBeenCalled();
  });
});

describe('ThreadListItem date (#891)', () => {
  // A migrated mailbox: the server stamped every message with the import day,
  // but the Date header still carries when the mail was really sent.
  const imported = { receivedAt: '2024-01-15T10:00:00Z', sentAt: '2019-03-05T08:30:00Z' };

  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
      interfaceLayout: 'default',
      dateFormat: 'full',
    });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox' });
  });

  it('shows the Date header, not the import time, on a single-message row', () => {
    const { container } = renderRow(makeEmail(imported));
    expect(container.textContent).toMatch(/2019/);
    expect(container.textContent).not.toMatch(/2024/);
  });

  it('shows the Date header of the latest message on a thread row', () => {
    const emails = [
      makeEmail({ id: 'a', receivedAt: '2024-01-15T09:00:00Z', sentAt: '2019-03-04T08:30:00Z' }),
      makeEmail({ id: 'b', ...imported }),
    ];
    const [thread] = groupEmailsByThread(emails);
    const { container } = render(
      <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />,
    );
    expect(container.textContent).toMatch(/2019/);
    expect(container.textContent).not.toMatch(/2024/);
  });
});

describe('ThreadListItem hover actions', () => {
  // When the row above is deleted from its hover actions, the next row slides
  // under the resting pointer. The browser then reports a pointerover whose
  // relatedTarget is the list around the row, and React builds no
  // onPointerEnter from that, so the row has to arm its actions on pointerover.
  const renderInList = (thread: ReturnType<typeof groupEmailsByThread>[number]) =>
    render(
      <div data-testid="list">
        <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} onDelete={() => {}} />
      </div>,
    );

  it.each([
    ['a single message', () => groupEmailsByThread([makeEmail()])[0]],
    ['a conversation', () => groupEmailsByThread([
      makeEmail({ id: 'a', receivedAt: '2024-01-15T10:00:00Z' }),
      makeEmail({ id: 'b', receivedAt: '2024-01-15T11:00:00Z' }),
    ])[0]],
  ])('mounts them for %s that slides under a resting pointer', (_name, makeThread) => {
    const { container } = renderInList(makeThread());
    expect(screen.queryByTestId('hover-action-delete')).toBeNull();
    const row = screen.queryByTestId('email-list-item') ?? container.querySelector('[data-unread]');
    expect(row).not.toBeNull();
    fireEvent.pointerOver(row!, { relatedTarget: screen.getByTestId('list') });
    expect(screen.getByTestId('hover-action-delete')).toBeTruthy();
  });
});

describe('ThreadListItem open message', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], showPreview: false, mailLayout: 'split', interfaceLayout: 'default' });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: '' });
  });

  // A tag view lists the own and the group's eaaaaab: opening one draws only that one open.
  it.each([
    ['own', makeEmail({ id: 'eaaaaab', sourceClientAccountId: 'login-a', sourceAccountId: 'cf' }), true],
    ['group', makeEmail({ id: 'eaaaaab', sourceClientAccountId: 'login-a', sourceAccountId: 'ce' }), false],
  ])('draws the %s row as open only when it is the open message', (_name, email, open) => {
    const [thread] = groupEmailsByThread([email]);
    const { container } = render(
      <ThreadListItem thread={thread} isExpanded={false} selectedEmailKey="login-a/cf:eaaaaab" onToggleExpand={() => {}} onEmailSelect={() => {}} />,
    );
    expect(container.querySelector('[aria-current="true"]') !== null).toBe(open);
  });
});
