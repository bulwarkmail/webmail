import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchResultCount } from '../search-result-count';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`,
}));

const mail = (id: string, threadId: string): Email => ({
  id,
  threadId,
  mailboxIds: { inbox: true },
  keywords: {},
  size: 1,
  receivedAt: '2026-10-24T10:00:00Z',
  hasAttachment: false,
} as Email);

// Ten messages in three conversations: Greta's one, a reply chain of six and one of three.
const results = [
  mail('g', 't1'),
  ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => mail(id, 't2')),
  ...['x', 'y', 'z'].map((id) => mail(id, 't3')),
];

beforeEach(() => {
  useSettingsStore.setState({ disableThreading: false });
});

// mail-16: the line above the results counts the rows the list shows.
describe('SearchResultCount', () => {
  it('counts conversations and their messages when the list groups them', () => {
    const { container } = render(<SearchResultCount emails={results} hasMore={false} />);
    expect(container.textContent).toBe('mail_list_extra.search_count {"conversations":3,"messages":10}');
  });

  // mail-p3-7: the rows are conversations, so the line says so.
  it('counts conversations when every result is its own conversation', () => {
    const { container } = render(<SearchResultCount emails={results.slice(0, 1)} hasMore={false} />);
    expect(container.textContent).toBe('mail_p3_list.conversations_found {"count":1}');
  });

  it('says no results when nothing matched', () => {
    const { container } = render(<SearchResultCount emails={[]} hasMore={false} />);
    expect(container.textContent).toBe('mail_p3_list.conversations_found {"count":0}');
  });

  it('counts messages when conversations are switched off', () => {
    useSettingsStore.setState({ disableThreading: true });
    const { container } = render(<SearchResultCount emails={results} hasMore={false} />);
    expect(container.textContent).toBe('advanced_search.results_found {"count":10}');
  });

  it('counts conversations while more can load and the list groups them', () => {
    const { container } = render(<SearchResultCount emails={results} hasMore />);
    expect(container.textContent).toBe('email_list.conversations_count_plus {"count":3}');
  });

  it('keeps "10+ results" while more can load and conversations are off', () => {
    useSettingsStore.setState({ disableThreading: true });
    const { container } = render(<SearchResultCount emails={results} hasMore />);
    expect(container.textContent).toBe('advanced_search.results_found_more {"count":10}');
  });
});
