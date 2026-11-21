import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore, DEFAULT_KEYWORDS, type Density } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useUIStore } from '@/stores/ui-store';
import { groupEmailsByThread } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';

// #1809: a received message's priority shows on its row (a red "!" for
// high, a down arrow for low) and as a badge in the reader.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { ThreadListItem } = await import('../thread-list-item');
const { EmailViewer } = await import('../email-viewer');

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

function renderRow(emails: Email[]) {
  const [thread] = groupEmailsByThread(emails);
  return render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />);
}

const highMark = (c: HTMLElement) => c.querySelector('[data-priority-mark="high"]');

afterEach(cleanup);

describe('priority on list rows', () => {
  beforeEach(() => {
    useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], showPreview: false, interfaceLayout: 'default', mailLayout: 'split' });
    useEmailStore.setState({ selectedEmailKeys: new Set<string>(), selectedMailbox: 'inbox', isUnifiedView: false });
  });

  const layouts: Array<[string, Record<string, unknown>]> = [
    ['stacked rows', { mailLayout: 'split', interfaceLayout: 'default' }],
    ['one-line rows', { mailLayout: 'focus', interfaceLayout: 'default' }],
    ['Mountain View rows', { mailLayout: 'focus', interfaceLayout: 'mountain-view' }],
  ];
  const densities: Density[] = ['extra-compact', 'compact', 'regular', 'comfortable'];

  describe.each(layouts)('%s', (_name, settings) => {
    it.each(densities)('marks high priority in %s density, for screen readers too', (density) => {
      useSettingsStore.setState({ ...settings, density });
      const { container } = renderRow([makeEmail({ priority: 'high' })]);
      expect(highMark(container)).not.toBeNull();
      expect(container.textContent).toContain('high_importance');
    });

    it('marks low priority and leaves normal mail alone', () => {
      useSettingsStore.setState(settings);
      const low = renderRow([makeEmail({ priority: 'low' })]);
      expect(low.container.textContent).toContain('low_importance');
      expect(highMark(low.container)).toBeNull();
      cleanup();
      const normal = renderRow([makeEmail()]);
      expect(normal.container.textContent).not.toContain('importance');
    });

    it('marks a conversation that holds a high priority message', () => {
      useSettingsStore.setState(settings);
      const { container } = renderRow([
        makeEmail({ id: 'e1', threadId: 't1', priority: 'high' }),
        makeEmail({ id: 'e2', threadId: 't1', receivedAt: '2024-01-16T10:00:00Z' }),
      ]);
      expect(highMark(container)).not.toBeNull();
    });
  });
});

describe('priority in the reader', () => {
  const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
  const message = (headers: Record<string, string>) => ({
    ...makeEmail(), blobId: 'b1', to: [{ email: 'me@example.org' }], preview: 'x',
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [], bodyValues: { '1': { value: 'Body' } },
    headers,
  }) as unknown as Email;

  async function viewer(email: Email) {
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }

  it('shows "High importance" from X-Priority', async () => {
    await viewer(message({ 'X-Priority': ' 1 (Highest)' }));
    const chip = screen.getAllByTestId('importance-chip')[0];
    expect(chip.getAttribute('data-priority')).toBe('high');
    expect(chip.textContent).toContain('high_importance');
  });

  it('shows "Low importance" from Importance', async () => {
    await viewer(message({ Importance: ' low' }));
    expect(screen.getAllByTestId('importance-chip')[0].getAttribute('data-priority')).toBe('low');
  });

  it('shows nothing for normal mail', async () => {
    await viewer(message({ 'X-Priority': ' 3 (Normal)' }));
    expect(screen.queryByTestId('importance-chip')).toBeNull();
  });
});
