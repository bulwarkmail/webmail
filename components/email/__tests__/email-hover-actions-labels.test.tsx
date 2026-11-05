import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { EmailHoverActions } from '../email-hover-actions';

vi.mock('@/components/plugins/plugin-actions', () => ({
  PluginActions: () => null,
  usePluginActions: () => [],
  useMessageActionTarget: () => ({ accountKind: 'personal', keywords: [] }),
  useRowActionTarget: (target: unknown) => target,
}));

// R10: one word per action. The row's quick actions say what the row's menu
// says ("Report spam", "Mark as unread"), not "Mark as Spam" or "Mark Read /
// Unread", and they are named for screen readers.

const email = { id: 'e1', keywords: { $seen: true, $flagged: true }, mailboxIds: { inbox: true } } as unknown as Email;

beforeEach(() => {
  useSettingsStore.setState({ hoverActions: ['markRead', 'star', 'spam', 'delete'], interfaceLayout: 'default', hoverActionsMode: 'inline' } as never);
});

describe('row quick actions', () => {
  it('use the menu words for the row as it is', () => {
    render(<EmailHoverActions email={email} onMarkAsRead={vi.fn()} onToggleStar={vi.fn()} onMarkAsSpam={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'mark_unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'unstar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'mark_as_spam' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'delete' })).toBeTruthy();
  });
});

describe('row quick action colours', () => {
  it('take the theme colours, Delete the destructive one', () => {
    render(<EmailHoverActions email={email} onMarkAsRead={vi.fn()} onToggleStar={vi.fn()} onMarkAsSpam={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'delete' }).className).toContain('hover:text-destructive');
    for (const name of ['mark_unread', 'unstar', 'mark_as_spam']) {
      expect(screen.getByRole('button', { name }).className).not.toMatch(/(blue|green|purple|orange|amber)-\d00/);
    }
  });
});
