import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadListItem } from '../thread-list-item';
import { ThreadEmailItem } from '../thread-email-item';
import { TagDisplayContext } from '@/hooks/use-tag-display';
import { groupEmailsByThread } from '@/lib/thread-utils';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@/stores/auth-store', () => {
  const state = { identities: [], username: null, client: null, activeAccountId: null, getClientForAccount: () => undefined };
  return { useAuthStore: Object.assign((selector?: (value: typeof state) => unknown) => selector ? selector(state) : state, { getState: () => state }) };
});
vi.mock('@/stores/account-store', () => {
  const account = { id: 'a', avatarColor: '#0d9488', email: 'a@example.invalid' };
  const state = { accounts: [account, { ...account, id: 'b' }], getAccountById: () => account };
  return { useAccountStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});

beforeEach(() => {
  useSettingsStore.setState({ emailKeywords: [
    { id: 'work', label: 'Work', color: 'red' },
    { id: 'long', label: 'InternationalInfrastructureModernizationProject', color: 'blue' },
  ], showColorNames: false, showPreview: false, showAccountDot: true, tintListRowsByAccount: false,
  mailLayout: 'split', interfaceLayout: 'default', listColumns: false, density: 'regular' });
  useUIStore.setState({ isMobile: false, isTablet: false, isDesktop: true });
  useEmailStore.setState({ selectedEmailKeys: new Set(), selectedMailbox: 'inbox', isUnifiedView: true,
    mailboxes: [{ id: 'inbox', role: 'inbox' } as never] });
});

function rows({ child = false, count = 1, layout = 'split', rtl = false, dot = false, tagged = true, placement }: {
  child?: boolean; count?: number; layout?: string; rtl?: boolean; dot?: boolean; tagged?: boolean; placement?: 'sender' | 'subject';
} = {}) {
  useSettingsStore.setState({ mailLayout: layout === 'split' ? 'split' : 'focus',
    interfaceLayout: layout === 'mountain' ? 'mountain-view' : 'default', listColumns: layout === 'columns' });
  const emails: Email[] = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`, threadId: 'thread', from: [{ name: 'UnbrokenSender'.repeat(20), email: 'sender@example.invalid' }],
    mailboxIds: { inbox: true }, keywords: { $seen: true, $flagged: true, ...(tagged ? { '$label:work': true, '$label:long': true } : {}) },
    subject: 'Synthetic subject', preview: 'Synthetic preview', size: 1024, receivedAt: '2026-01-15T10:00:00Z',
    hasAttachment: true, accountId: 'a', accountLabel: 'Account A',
  }));
  return <div dir={rtl ? 'rtl' : 'ltr'}><TagDisplayContext.Provider value={{ variant: dot ? 'dot' : 'badge', placement: placement ?? (layout === 'split' ? 'sender' : 'subject') }}>
    {child ? <ThreadEmailItem email={emails[0]} /> : <ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />}
  </TagDisplayContext.Provider></div>;
}

// These assert CSS contracts only; native rendering checks establish geometry.
describe('list-row tag suffix classes', () => {
  it.each([
    { name: 'individual / split', layout: 'split' },
    { name: 'collapsed / compact / RTL', count: 3, layout: 'split', dot: true, rtl: true },
    { name: 'individual / focus', layout: 'focus' },
    { name: 'collapsed / Mountain View / RTL', count: 3, layout: 'mountain', rtl: true },
    { name: 'expanded child', child: true },
    { name: 'expanded child / columns / RTL', child: true, layout: 'columns', rtl: true },
  ])('$name wraps tags in one bounded flex line, outside controls', options => {
    const { container } = render(rows(options));
    const suffixes = container.querySelectorAll<HTMLElement>('.flex-wrap.overflow-hidden');
    expect(suffixes).toHaveLength(1);
    const suffix = suffixes[0];
    expect(suffix).toHaveClass('min-w-0', 'shrink', 'content-start', 'h-[calc(1lh+0.25rem+2px)]', 'has-[[data-tag-dot]]:h-4');
    expect(suffix.children).toHaveLength(2);
    for (const tag of suffix.children) expect(tag).toHaveClass('shrink-0', 'max-w-[min(12rem,100%)]');
    const yieldingText = Array.from(container.querySelectorAll<HTMLElement>('.truncate')).filter(node => node.classList.contains('shrink-[9999]'));
    expect(yieldingText.length).toBeGreaterThan(0);
    expect(yieldingText.every(node => node.classList.contains('min-w-0'))).toBe(true);
    expect(suffix.querySelector('.tabular-nums, svg, button, [data-expand-toggle]')).toBeNull();
    expect(container.querySelector('.tabular-nums')).not.toBeNull();
    const count = container.querySelector('[title="messages_tooltip"]');
    if (count) expect(suffix.contains(count)).toBe(false);
    const account = container.querySelector('[title="Account A, a@example.invalid"]');
    if (account) expect(suffix.contains(account)).toBe(false);
  });

  it.each([{ count: 1 }, { count: 3 }, { child: true }])('bounds sender allocation without intrinsic tag competition: %o', options => {
    const { container } = render(rows(options));
    const sender = container.querySelector('.max-w-24');
    expect(sender).toHaveClass('min-w-0', 'shrink-[2]', 'truncate');
    expect(container.querySelector('.flex-wrap.overflow-hidden')).toHaveClass('basis-12', 'grow');
  });

  it.each([{ tagged: false }, { placement: 'subject' as const }])('leaves sender allocation unchanged without adjacent tags: %o', options => {
    const { container } = render(rows(options));
    expect(container.querySelector('.max-w-24')).toBeNull();
  });

  it.each([
    { layout: 'split', placement: 'subject' as const, count: 1 },
    { layout: 'split', placement: 'subject' as const, count: 3 },
    { layout: 'focus', count: 1 },
    { layout: 'mountain', count: 3 },
  ])('bounds subject allocation beside tags: %o', options => {
    const { container } = render(rows(options));
    const subject = Array.from(container.querySelectorAll('.truncate')).find(node => node.textContent === 'Synthetic subject');
    expect(subject).toHaveClass('min-w-0', 'max-w-40', 'shrink-[2]');
    expect(container.querySelector('.flex-wrap.overflow-hidden')).toHaveClass('basis-12', 'grow');
  });

  it.each(['split', 'focus'])('preserves untagged subject allocation in %s', layout => {
    const { container } = render(rows({ layout, placement: 'subject', tagged: false }));
    expect(container.querySelector('.max-w-40')).toBeNull();
    expect(container.querySelector('.basis-12')).toBeNull();
  });

  it('follows the existing named-dot accessibility setting without another rendering tree', () => {
    const { container } = render(rows({ dot: true }));
    expect(container.querySelectorAll('[data-tag-dot]')).toHaveLength(2);
    act(() => useSettingsStore.setState({ showColorNames: true }));
    expect(container.querySelector('[data-tag-dot]')).toBeNull();
    expect(container.querySelector('.flex-wrap.overflow-hidden')?.children).toHaveLength(2);
    expect(container.querySelectorAll('[title="Work"]')).toHaveLength(1);
  });
});
