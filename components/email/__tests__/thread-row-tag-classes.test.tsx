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

function rows({ child = false, count = 1, layout = 'split', rtl = false, dot = false, tagged = true, placement, expanded = false }: {
  child?: boolean; count?: number; layout?: string; rtl?: boolean; dot?: boolean; tagged?: boolean; placement?: 'sender' | 'subject'; expanded?: boolean;
} = {}) {
  useSettingsStore.setState({ mailLayout: layout === 'split' ? 'split' : 'focus',
    interfaceLayout: layout === 'mountain' ? 'mountain-view' : 'default', listColumns: layout === 'columns' });
  const emails: Email[] = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`, threadId: 'thread', from: [{ name: 'UnbrokenSender'.repeat(20), email: 'sender@example.invalid' }],
    mailboxIds: { inbox: true }, keywords: { $seen: true, $flagged: true, $answered: true, ...(tagged ? { '$label:work': true, '$label:long': true } : {}) },
    subject: 'Synthetic subject', preview: 'Synthetic preview', size: 1024, receivedAt: '2026-01-15T10:00:00Z',
    hasAttachment: true, accountId: 'a', accountLabel: 'Account A',
  }));
  return <div dir={rtl ? 'rtl' : 'ltr'}><TagDisplayContext.Provider value={{ variant: dot ? 'dot' : 'badge', placement: placement ?? (layout === 'split' ? 'sender' : 'subject') }}>
    {child ? <ThreadEmailItem email={emails[0]} /> : <ThreadListItem thread={groupEmailsByThread(emails)[0]} isExpanded={expanded} onToggleExpand={() => {}} onEmailSelect={() => {}} />}
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
    expect(suffix).toHaveClass('min-w-0', 'max-w-[50%]', 'shrink', 'content-start', 'h-[calc(1lh+0.25rem+2px)]', 'has-[[data-tag-dot]]:h-4');
    expect(suffix).not.toHaveClass('grow');
    expect(suffix).not.toHaveClass('basis-12');
    expect(suffix.children).toHaveLength(2);
    for (const tag of suffix.children) expect(tag).toHaveClass('shrink-0', 'max-w-[min(12rem,100%)]');
    const yieldingText = Array.from(container.querySelectorAll<HTMLElement>('.truncate')).filter(node => node.classList.contains('flex-1'));
    expect(yieldingText.length).toBeGreaterThan(0);
    expect(yieldingText.every(node => node.classList.contains('min-w-0'))).toBe(true);
    expect(suffix.querySelector('.tabular-nums, svg, button, [data-expand-toggle]')).toBeNull();
    expect(container.querySelector('.tabular-nums')).not.toBeNull();
    const count = container.querySelector('[title="messages_tooltip"]');
    if (count) expect(suffix.contains(count)).toBe(false);
    const account = container.querySelector('[title="Account A, a@example.invalid"]');
    if (account) expect(suffix.contains(account)).toBe(false);
  });

  it.each([{ count: 1 }, { count: 3 }, { child: true }])('lets sender text yield without PR-added caps: %o', options => {
    for (const tagged of [false, true]) {
      const { container, unmount } = render(rows({ ...options, tagged }));
      const sender = Array.from(container.querySelectorAll('.truncate')).find(node => node.textContent?.includes('UnbrokenSender'));
      expect(sender).toHaveClass('flex-1', 'min-w-0', 'truncate');
      expect(sender).not.toHaveClass('max-w-24');
      expect(sender).not.toHaveClass('shrink-[9999]');
      expect(container.querySelectorAll('.flex-wrap.overflow-hidden')).toHaveLength(tagged ? 1 : 0);
      // The expanded child's original sender-column constraint is retained.
      if ('child' in options && options.child) expect(sender).toHaveClass('max-w-[150px]');
      unmount();
    }
  });

  it.each(['split', 'focus', 'mountain', 'columns'])('leaves tagged and untagged subjects uncapped in %s', layout => {
    for (const count of [1, 3]) for (const tagged of [false, true]) {
      const { container, unmount } = render(rows({ layout, count, tagged, placement: 'subject' }));
      const subject = Array.from(container.querySelectorAll('.truncate')).find(node => node.textContent === 'Synthetic subject');
      expect(subject).toHaveClass('flex-1', 'min-w-0', 'truncate');
      expect(subject).not.toHaveClass('max-w-40');
      expect(subject).not.toHaveClass('shrink-[2]');
      const suffix = container.querySelector('.flex-wrap.overflow-hidden');
      if (tagged) {
        expect(suffix).toHaveClass('max-w-[50%]', 'shrink');
        expect(suffix).not.toHaveClass('grow');
        expect(suffix).not.toHaveClass('basis-12');
      } else expect(suffix).toBeNull();
      unmount();
    }
  });

  it.each(['focus', 'mountain'])('lets one-line sender columns shrink while retaining preferred widths in %s', layout => {
    for (const count of [1, 3]) for (const tagged of [false, true]) {
      const { container, unmount } = render(rows({ layout, count, tagged }));
      const senderColumn = container.querySelector('.w-32');
      expect(senderColumn).toHaveClass('min-w-0', 'shrink', 'lg:w-40');
      expect(senderColumn).not.toHaveClass('shrink-0');
      unmount();
    }
  });

  it.each([1, 3])('retains the explicit From column constraint for %i messages', count => {
    const { container } = render(rows({ layout: 'columns', count }));
    expect(container.querySelector('.w-40')).toHaveClass('shrink-0', 'lg:w-56');
  });

  it.each(['split', 'focus'])('keeps thread count, status and date in a protected wrapping suffix in %s', layout => {
    for (const tagged of [false, true]) for (const rtl of [false, true]) {
      const { container, unmount } = render(rows({ layout, count: 3, tagged, rtl }));
      const count = container.querySelector('[title="messages_tooltip"]')!;
      const suffix = count.parentElement!;
      expect(suffix).toHaveClass('shrink-0', 'max-w-full', 'flex-wrap', 'justify-end');
      expect(suffix.parentElement).toHaveClass('flex-wrap');
      expect(suffix.querySelector('.tabular-nums')).not.toBeNull();
      expect(suffix.querySelector('.fill-amber-400')).not.toBeNull();
      expect(suffix.querySelector('.tabler-icon-arrow-back-up')).not.toBeNull();
      // The existing row boundary clips swipe/hover layers, not this control lane.
      expect(suffix.closest('.overflow-hidden')).toBe(suffix.closest('[role="row"]'));
      expect(suffix.querySelector('.overflow-hidden')).toBeNull();
      expect(suffix.previousElementSibling).toHaveClass('min-w-0', 'flex-1');
      unmount();
    }
  });

  it('keeps Mountain View counts with the sender names', () => {
    const { container } = render(rows({ layout: 'mountain', count: 3 }));
    expect(container.querySelector('[title="messages_tooltip"]')?.closest('[data-mv-names]')).not.toBeNull();
  });

  it('keeps status and date outside clipped tags in actual expanded children', () => {
    const { container } = render(rows({ count: 3, expanded: true }));
    const renderedRows = Array.from(container.querySelectorAll('[role="row"]'));
    expect(renderedRows).toHaveLength(4);
    for (const row of renderedRows.slice(1)) {
      expect(row.querySelector('.fill-amber-400')?.closest('.overflow-hidden')).toBeNull();
      expect(row.querySelector('.tabular-nums')?.closest('.overflow-hidden')).toBeNull();
      expect(row.querySelector('.fill-amber-400')).not.toBeNull();
      expect(row.querySelector('.tabular-nums')).not.toBeNull();
    }
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
