import { act, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { Profiler } from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// A click on another folder changes the selection at once, while the old
// rows stay on screen until the new folder's rows come. The rows on screen
// keep drawing as rows of the folder they came from (sender in the Inbox,
// recipient in Sent) and are not drawn again for the click; a tick or a new
// empty selection only draws the rows whose tick changed.

// Translators that keep their identity, as next-intl's do (the shared mock
// makes a new one per call, which would draw every row on each list render).
vi.mock('next-intl', () => {
  const t = (key: string) => key;
  const format = { dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) };
  return { useTranslations: () => t, useLocale: () => 'en', useFormatter: () => format };
});
// Called once per render of a row: the render counter.
const useEmailDrag = vi.fn(() => ({ dragHandlers: {}, isDragging: false }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1' })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const { EmailList } = await import('../email-list');
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const folder = (id: string, role: string) =>
  ({ id, name: id, role, unreadEmails: 0, totalEmails: 1 }) as unknown as Mailbox;
const makeEmail = (id: string, box: string): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { [box]: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-09-30T10:00:00Z',
  from: [{ name: `Sender ${id}`, email: `${id}@example.com` }],
  to: [{ name: `Recipient ${id}`, email: `to-${id}@example.com` }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

const INBOX = [makeEmail('a', 'inbox'), makeEmail('b', 'inbox')];
const SENT = [makeEmail('c', 'sent')];

const element = HTMLElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { element.scrollTo = vi.fn(); });
afterAll(() => { delete element.scrollTo; });

beforeEach(() => {
  useEmailStore.setState({
    selectedMailbox: 'inbox', mailboxes: [folder('inbox', 'inbox'), folder('sent', 'sent')],
    isUnifiedView: false, unifiedRole: null, selectedEmailKeys: new Set(),
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute('data-index') ? 100 : 600;
    return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); useEmailDrag.mockClear(); });

function List({ emails }: { emails: Email[] }) {
  return <EmailList emails={emails} />;
}

describe('rows during a folder switch', () => {
  it('stay rows of their own folder, undrawn, until the new rows come', async () => {
    const { rerender } = render(<List emails={INBOX} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByText('Sender a')).toBeInTheDocument();
    const drawn = useEmailDrag.mock.calls.length;

    // The click: Sent is selected, the Inbox rows are still the ones shown.
    act(() => { useEmailStore.setState({ selectedMailbox: 'sent', selectedEmailKeys: new Set() }); });
    rerender(<List emails={INBOX} />);
    expect(screen.getByText('Sender a')).toBeInTheDocument();
    expect(screen.queryByText('Recipient a')).toBeNull();
    expect(useEmailDrag.mock.calls.length).toBe(drawn);

    // Sent's rows came: they show their recipients.
    rerender(<List emails={SENT} />);
    expect(await screen.findByText('Recipient c')).toBeInTheDocument();
  });

  it('a tick draws only the row ticked', async () => {
    render(<List emails={INBOX} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const drawn = useEmailDrag.mock.calls.length;
    act(() => { useEmailStore.setState({ selectedEmailKeys: new Set(['a']) }); });
    // Row a is ticked; the list enters selection mode, so both rows change
    // how a click acts and draw once.
    const afterFirst = useEmailDrag.mock.calls.length;
    expect(afterFirst - drawn).toBeLessThanOrEqual(2);
    act(() => { useEmailStore.setState({ selectedEmailKeys: new Set(['a']) }); });
    // The same ticks in a new set draw nothing.
    expect(useEmailDrag.mock.calls.length).toBe(afterFirst);
  });

  it('a new view updates the rows on screen instead of replacing them', async () => {
    const { container, rerender } = render(<List emails={INBOX} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const firstRow = container.querySelector('[data-index="0"] [data-testid="email-list-item"]');
    expect(firstRow?.getAttribute('data-email-id')).toBe('a');
    act(() => { useEmailStore.setState({ selectedMailbox: 'sent' }); });
    rerender(<List emails={SENT} />);
    const after = container.querySelector('[data-index="0"] [data-testid="email-list-item"]');
    expect(after?.getAttribute('data-email-id')).toBe('c');
    expect(after).toBe(firstRow);
    expect(await screen.findByText('Recipient c')).toBeInTheDocument();
  });

  it('a page loaded below leaves the rows on screen undrawn', async () => {
    // Scrolling a large folder loads page after page; each one drew every
    // row on screen again when the rows' folder object was new with it.
    const { rerender } = render(<List emails={INBOX} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    useEmailDrag.mockClear();
    const older = { ...makeEmail('y', 'inbox'), receivedAt: '2026-09-01T10:00:00Z' };
    act(() => { rerender(<List emails={[...INBOX, older]} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const drawn = useEmailDrag.mock.calls.map((call) => (call as unknown as [{ email: Email }])[0].email.id);
    expect(drawn.filter((id) => id === 'a' || id === 'b')).toEqual([]);
  });

  it('within a view, a new message at the top leaves the other rows as they are', async () => {
    const { container, rerender } = render(<List emails={INBOX} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const rowA = container.querySelector('[data-email-id="a"]');
    const newest = { ...makeEmail('z', 'inbox'), receivedAt: '2026-10-01T10:00:00Z' };
    rerender(<List emails={[newest, ...INBOX]} />);
    expect(container.querySelector('[data-email-id="a"]')).toBe(rowA);
    expect(container.querySelector('[data-email-id="z"]')).not.toBe(rowA);
  });

  it('places a new list with the row height it measured, so it is drawn once', async () => {
    let commits = 0;
    const tree = (emails: Email[]) => <Profiler id="list" onRender={() => { commits++; }}><List emails={emails} /></Profiler>;
    const { rerender } = render(tree(INBOX));
    // Past the first draw's extra rows (a frame, then a task), also on a busy machine.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    const more = [makeEmail('d', 'sent'), makeEmail('e', 'sent'), makeEmail('f', 'sent')];
    commits = 0;
    act(() => { rerender(tree(more)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(commits).toBe(1);
  });

  it('places the first list at the real row height, so measuring the rows moves nothing', () => {
    useSettingsStore.setState({ density: 'regular', showPreview: true } as never);
    const firstDraw = (rowHeight: number) => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const height = this.hasAttribute('data-index') ? rowHeight : 600;
        return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
      });
      let commits = 0;
      const { unmount } = render(<Profiler id="list" onRender={() => { commits++; }}><List emails={INBOX} /></Profiler>);
      unmount();
      return commits;
    };
    // A regular row with a preview line is 95.75px in Chromium; a guess that
    // is off costs a draw more when the rows are measured.
    expect(firstDraw(95.75)).toBeLessThan(firstDraw(90));
  });
});

describe('rows drawn again for another folder', () => {
  // A row on screen is kept for the next folder's message at its place, so
  // it has to be measured again for that message: a row without a preview
  // line can be another height than the one that showed before (a larger
  // font, Firefox). Kept at the old height, the rows below overlapped it.
  it('are measured for the message they show now', async () => {
    useSettingsStore.setState({ density: 'regular', showPreview: true } as never);
    const withPreview = (id: string) => ({ ...makeEmail(id, 'inbox'), preview: `A preview of ${id}` });
    const { rerender, container } = render(<List emails={[withPreview('a'), withPreview('b'), withPreview('c')]} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    const tops = () => [...container.querySelectorAll<HTMLElement>('[data-index]')]
      .sort((x, y) => Number(x.dataset.index) - Number(y.dataset.index))
      .map((el) => parseFloat(el.style.top));
    expect(tops()).toEqual([0, 100, 200]);
    // Sent: no previews, so a shape the list hasn't measured yet.
    act(() => { rerender(<List emails={[makeEmail('d', 'sent'), makeEmail('e', 'sent'), makeEmail('f', 'sent')]} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByText('Mail d')).toBeInTheDocument();
    expect(tops()).toEqual([0, 100, 200]);
  });
});
