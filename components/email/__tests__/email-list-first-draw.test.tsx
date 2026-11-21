import { act, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1', getClientForAccount: () => undefined })),
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

const makeEmail = (id: string): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-09-30T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

const EMAILS = Array.from({ length: 30 }, (_, i) => makeEmail(`m${i}`));

const element = HTMLElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { element.scrollTo = vi.fn(); });
afterAll(() => { delete element.scrollTo; });

beforeEach(() => {
  useEmailStore.setState({ selectedMailbox: 'inbox' });
  // A 300px list of 100px rows: three rows on screen.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute('data-index') ? 100 : 300;
    return { x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const drawnRows = (container: HTMLElement) => container.querySelectorAll('[data-index]').length;

describe('the first draw of the message list', () => {
  it('waits only for the rows near the screen, and adds the rest after it is drawn', async () => {
    const { container } = render(<EmailList emails={EMAILS} />);
    const first = drawnRows(container);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const after = drawnRows(container);
    expect(first).toBeLessThan(after);
    expect(after - first).toBe(4);
  });
});
