import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ identities: [] }),
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

describe('ThreadListItem shift-range checkbox', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      emailKeywords: [...DEFAULT_KEYWORDS],
      showPreview: false,
      mailLayout: 'split',
    });
  });

  it('shift-clicking the checkbox extends the selection from the anchor', () => {
    const e1 = makeEmail({ id: 'e1', threadId: 't1' });
    const e2 = makeEmail({ id: 'e2', threadId: 't2' });
    const e3 = makeEmail({ id: 'e3', threadId: 't3' });
    // Selection mode active so the checkbox renders, with the anchor on e1.
    useEmailStore.setState({
      emails: [e1, e2, e3],
      selectedEmailIds: new Set(['e1']),
      lastSelectedEmailId: 'e1',
      selectedMailbox: 'inbox',
    });

    renderRow(e3);
    const checkbox = screen.getAllByRole('button')[0];
    act(() => {
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
