import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailListItem } from '../email-list-item';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

// Mock the drag hook
vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));

// Mock identity badge
vi.mock('../email-identity-badge', () => ({
  EmailIdentityBadge: () => null,
}));

// Mock auth store
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

describe('EmailListItem tag badge', () => {
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

  it('does not show tag badge when email has no label keyword', () => {
    const email = makeEmail({ keywords: { $seen: true } });
    render(<EmailListItem email={email} />);
    expect(screen.getByText('Test Subject')).toBeInTheDocument();
    // No keyword label should appear
    DEFAULT_KEYWORDS.forEach((kw) => {
      expect(screen.queryByText(kw.label)).not.toBeInTheDocument();
    });
  });

  it('shows tag badge with label when email has $label: keyword', () => {
    const email = makeEmail({ keywords: { $seen: true, '$label:red': true } });
    render(<EmailListItem email={email} />);
    expect(screen.getByText('Red')).toBeInTheDocument();
  });

  it('shows tag badge for legacy $color: keyword', () => {
    const email = makeEmail({ keywords: { $seen: true, '$color:blue': true } });
    render(<EmailListItem email={email} />);
    expect(screen.getByText('Blue')).toBeInTheDocument();
  });

  it('does not show badge when keyword id not in settings', () => {
    const email = makeEmail({ keywords: { $seen: true, '$label:unknown-tag': true } });
    render(<EmailListItem email={email} />);
    expect(screen.queryByText('unknown-tag')).not.toBeInTheDocument();
  });

  it('shows custom keyword label', () => {
    useSettingsStore.setState({
      emailKeywords: [
        ...DEFAULT_KEYWORDS,
        { id: 'work', label: 'Work', color: 'teal' },
      ],
    });
    const email = makeEmail({ keywords: { $seen: true, '$label:work': true } });
    render(<EmailListItem email={email} />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('updates badge when keyword definition changes', () => {
    const email = makeEmail({ keywords: { $seen: true, '$label:red': true } });
    const { rerender } = render(<EmailListItem email={email} />);
    expect(screen.getByText('Red')).toBeInTheDocument();

    // Update label name
    act(() => {
      useSettingsStore.getState().updateKeyword('red', { label: 'Urgent' });
    });
    rerender(<EmailListItem email={email} />);
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByText('Red')).not.toBeInTheDocument();
  });

  it('renders subject even without tag', () => {
    const email = makeEmail({ subject: 'Hello World' });
    render(<EmailListItem email={email} />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders inline preview text in focused mail layout', () => {
    useSettingsStore.setState({
      showPreview: true,
      mailLayout: 'focus',
    });
    const email = makeEmail({ preview: 'Inline preview content' });
    const { container } = render(<EmailListItem email={email} />);

    expect(screen.getByText('Test Subject')).toBeInTheDocument();
    expect(screen.getByText(/Inline preview content/)).toBeInTheDocument();
    expect(container.querySelector('p')).toBeNull();
  });
});
