import { render, renderHook, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { formatDate } from '@/lib/utils';
import { TagDisplayContext, useMeasuredTagDisplay } from '@/hooks/use-tag-display';
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

describe('ThreadListItem tag badge', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
    });
    useEmailStore.setState({
      selectedEmailIds: new Set<string>(),
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
    });
    useEmailStore.setState({
      selectedEmailIds: new Set<string>(),
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

describe('ThreadListItem sender-line tags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the existing subject-line transition at 560px', () => {
    let onResize: ResizeObserverCallback = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { onResize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const element = document.createElement('div');
    const { result } = renderHook(() => useMeasuredTagDisplay({ current: element }));
    act(() => onResize([{ contentRect: { width: 559 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(result.current).toEqual({ variant: 'badge', placement: 'sender' });
    act(() => onResize([{ contentRect: { width: 560 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(result.current).toEqual({ variant: 'badge', placement: 'subject' });
  });

  it.each([1, 2])('progressively compacts and restores tags in a %i-message row', (messageCount) => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], showPreview: false, mailLayout: 'split' });
    useEmailStore.setState({ selectedEmailIds: new Set<string>(), selectedMailbox: 'inbox' });

    // Sender (40), attachment (14), two 8px gaps, optional count (34 + 4px
    // gap), and the 1px rounding allowance are outside the tag budget.
    const reservedWidth = 70 + (messageCount > 1 ? 38 : 0) + 1;
    let availableWidth = reservedWidth + 202;
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.getAttribute('data-tag-fit') === 'left') resizeCallbacks.add(this.callback);
      }
      unobserve() {}
      disconnect() { resizeCallbacks.delete(this.callback); }
    });
    const originalStyle = getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = originalStyle(element);
      const kind = element.getAttribute('data-tag-fit');
      if (kind === 'left' || kind === 'named') {
        Object.defineProperty(style, 'columnGap', { value: kind === 'left' ? '8px' : '4px', configurable: true });
      }
      return style;
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = (width: number, height = 22) => ({ width, height } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-tag-fit')) {
        case 'left': return rect(availableWidth);
        case 'sender': return rect(40);
        case 'dot': return rect(10, 10);
      }
      if (this.parentElement?.getAttribute('data-tag-fit') === 'named') {
        return this.querySelector('svg') ? rect(34, 18) : rect(Math.min(192, this.title.length * 7 + 16));
      }
      if (this.classList.contains('gap-1.5') && this.querySelector('svg')) return rect(14);
      return originalRect.call(this);
    });

    const tagIds = ['red', 'orange', 'green', 'blue'];
    const row = (ids: string[]) => {
      const keywords = Object.fromEntries([['$seen', true], ...ids.map((tag) => [`$label:${tag}`, true])]);
      const emails = Array.from({ length: messageCount }, (_, index) =>
        makeEmail({ id: `email-${index}`, keywords, hasAttachment: true }),
      );
      return (
        <TagDisplayContext.Provider value={{ variant: 'badge', placement: 'sender' }}>
          <ThreadListItem
            thread={groupEmailsByThread(emails)[0]}
            isExpanded={false}
            selectedEmailId={messageCount === 1 ? emails[0].id : undefined}
            onToggleExpand={() => {}}
            onEmailSelect={() => {}}
          />
        </TagDisplayContext.Provider>
      );
    };
    const { container, rerender } = render(row(tagIds));
    const firstTag = Array.from(container.querySelectorAll<HTMLElement>('[title="Red"]'))
      .find((element) => !element.closest('[data-tag-fit="named"]'))!;
    const tagGroup = firstTag.parentElement!;
    const tags = () => Array.from(tagGroup.children) as HTMLElement[];
    const expectLayout = (expected: string[]) => {
      expect(tags().map((tag) => tag.classList.contains('hidden') ? 'hidden'
        : tag.classList.contains('border') ? 'badge' : 'dot')).toEqual(expected);
      expect(tagGroup).toHaveStyle({ height: '22px' });
      expect(tagGroup).not.toHaveClass('flex-wrap');
    };
    const resize = (tagSpace: number) => {
      availableWidth = reservedWidth + tagSpace;
      act(() => Array.from(resizeCallbacks).forEach((callback) => callback([], {} as ResizeObserver)));
    };

    // Measured widths 37, 58, 51, 44 plus three 4px gaps total 202px.
    expectLayout(['badge', 'badge', 'badge', 'badge']);
    expect(tags().map((tag) => tag.title)).toEqual(['Red', 'Orange', 'Green', 'Blue']);
    resize(201);
    expectLayout(['badge', 'badge', 'badge', 'dot']);
    resize(168); // Exact fit with one dot; repeated observation must be stable.
    expectLayout(['badge', 'badge', 'badge', 'dot']);
    resize(168);
    expectLayout(['badge', 'badge', 'badge', 'dot']);
    resize(167);
    expectLayout(['badge', 'badge', 'dot', 'dot']);
    resize(126);
    expectLayout(['badge', 'dot', 'dot', 'dot']);
    resize(78);
    expectLayout(['dot', 'dot', 'dot', 'dot']);
    tags().forEach((tag, index) => expect(tag).toHaveClass(`bg-${tagIds[index]}-500`));

    resize(79);
    expectLayout(['badge', 'dot', 'dot', 'dot']);
    resize(127);
    expectLayout(['badge', 'badge', 'dot', 'dot']);
    resize(168);
    expectLayout(['badge', 'badge', 'badge', 'dot']);
    resize(202);
    expectLayout(['badge', 'badge', 'badge', 'badge']);

    resize(168);
    act(() => useSettingsStore.getState().updateKeyword('orange', { label: 'An exceptionally long project label' }));
    expectLayout(['badge', 'dot', 'dot', 'dot']);
    act(() => useSettingsStore.getState().updateKeyword('orange', { label: 'Orange' }));
    expectLayout(['badge', 'badge', 'badge', 'dot']);
    rerender(row(tagIds.slice(0, 3)));
    expectLayout(['badge', 'badge', 'badge']);
    rerender(row(tagIds));
    expectLayout(['badge', 'badge', 'badge', 'dot']);

    resize(52);
    expectLayout(['dot', 'dot', 'dot', 'dot']);
    resize(51); // The fourth dot must disappear whole.
    expectLayout(['dot', 'dot', 'dot', 'hidden']);
    resize(10);
    expectLayout(['dot', 'hidden', 'hidden', 'hidden']);
    resize(9); // Even a partially visible first dot is forbidden.
    expectLayout(['hidden', 'hidden', 'hidden', 'hidden']);
    resize(0);
    expectLayout(['hidden', 'hidden', 'hidden', 'hidden']);
    resize(202);
    expectLayout(['badge', 'badge', 'badge', 'badge']);

    if (messageCount === 1) {
      expect(screen.getByTestId('email-list-item')).toHaveAttribute('aria-current', 'true');
    } else {
      expect(tagGroup.previousElementSibling).toHaveClass('rounded-full');
      expect(tagGroup.previousElementSibling).not.toHaveClass('hidden', 'overflow-hidden');
    }
    expect(screen.getByText(formatDate(makeEmail().receivedAt)).parentElement).toHaveClass('flex-shrink-0');
  });
});

describe('ThreadListItem row content', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
    });
    useEmailStore.setState({
      selectedEmailIds: new Set<string>(),
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
});

describe('ThreadListItem shift-range avatar selection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
    });
  });

  it('shift-clicking the avatar extends the selection from the anchor', () => {
    const e1 = makeEmail({ id: 'e1', threadId: 't1' });
    const e2 = makeEmail({ id: 'e2', threadId: 't2' });
    const e3 = makeEmail({ id: 'e3', threadId: 't3' });
    // Selection mode active, with the anchor on e1.
    useEmailStore.setState({
      emails: [e1, e2, e3],
      selectedEmailIds: new Set(['e1']),
      lastSelectedEmailId: 'e1',
      selectedMailbox: 'inbox',
    });

    renderRow(e3);
    const avatar = screen.getByRole('checkbox');
    act(() => {
      avatar.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });

    const selected = useEmailStore.getState().selectedEmailIds;
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
      tintListRowsByTag: true,
    });
    useEmailStore.setState({
      selectedEmailIds: new Set(['email-1']),
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
