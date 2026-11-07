import { describe, it, expect, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// The mail view builds the reply's quote on each of its renders while the
// composer is open. For an HTML-only mail that parsed the whole mail each time.
const toText = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/html-to-text', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/html-to-text')>();
  return {
    ...real,
    htmlToPlainText: (...args: Parameters<typeof real.htmlToPlainText>) => {
      toText.calls++;
      return real.htmlToPlainText(...args);
    },
  };
});

const { getQuoteBodies } = await import('../email-composer-utils');

const htmlOnly = (html: string) => ({
  textBody: [{ partId: '1', type: 'text/html' }],
  htmlBody: [{ partId: '1', type: 'text/html' }],
  bodyValues: { '1': { value: html } },
  preview: 'Hello',
}) as unknown as Pick<Email, 'textBody' | 'htmlBody' | 'bodyValues' | 'preview'>;

describe('getQuoteBodies', () => {
  it('turns the same mail into text once', () => {
    const email = htmlOnly('<p>Hello <b>there</b></p>');
    toText.calls = 0;
    const first = getQuoteBodies(email);
    const again = getQuoteBodies(email);
    expect(again).toEqual(first);
    expect(first.body).toContain('Hello there');
    expect(toText.calls).toBe(1);
  });

  it('answers for the body the mail has now', () => {
    const email = htmlOnly('<p>Before</p>');
    expect(getQuoteBodies(email).body).toContain('Before');
    (email.bodyValues as Record<string, { value: string }>)['1'] = { value: '<p>After</p>' };
    expect(getQuoteBodies(email).body).toContain('After');
  });
});
