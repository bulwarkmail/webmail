import { describe, it, expect } from 'vitest';
import { emailDisplayDate, emailListDate, MAX_DELIVERY_DELAY_MS, MAX_FUTURE_SENT_AT_MS } from '@/lib/email-date';

// #891: migrated/restored mail gets receivedAt = import time; the Date header
// (sentAt) is the message's real date and must win for display.
describe('emailDisplayDate', () => {
  const receivedAt = '2026-08-20T12:00:00Z';

  it('prefers the Date header over the server receive time', () => {
    expect(emailDisplayDate({ sentAt: '2019-03-04T05:06:07Z', receivedAt })).toBe('2019-03-04T05:06:07Z');
  });

  it('falls back to receivedAt when there is no Date header', () => {
    expect(emailDisplayDate({ receivedAt })).toBe(receivedAt);
    expect(emailDisplayDate({ sentAt: undefined, receivedAt })).toBe(receivedAt);
    expect(emailDisplayDate({ sentAt: null, receivedAt })).toBe(receivedAt);
    expect(emailDisplayDate({ sentAt: '', receivedAt })).toBe(receivedAt);
  });

  it('falls back to receivedAt when the Date header is unparsable', () => {
    expect(emailDisplayDate({ sentAt: 'not-a-date', receivedAt })).toBe(receivedAt);
  });

  it('tolerates ordinary clock skew (Date slightly after receipt)', () => {
    const skewed = new Date(Date.parse(receivedAt) + 5 * 60 * 1000).toISOString();
    expect(emailDisplayDate({ sentAt: skewed, receivedAt })).toBe(skewed);
  });

  it('ignores a Date header implausibly far in the future (forged spam dates)', () => {
    const forged = new Date(Date.parse(receivedAt) + MAX_FUTURE_SENT_AT_MS + 1000).toISOString();
    expect(emailDisplayDate({ sentAt: forged, receivedAt })).toBe(receivedAt);
  });

  it('uses sentAt when receivedAt is missing or unparsable', () => {
    expect(emailDisplayDate({ sentAt: '2019-03-04T05:06:07Z' })).toBe('2019-03-04T05:06:07Z');
    expect(emailDisplayDate({ sentAt: '2019-03-04T05:06:07Z', receivedAt: 'garbage' })).toBe('2019-03-04T05:06:07Z');
  });

  it('returns undefined when neither is present', () => {
    expect(emailDisplayDate({})).toBeUndefined();
  });
});

// mail-17: the list sorts by receivedAt, so it shows receivedAt too.
describe('emailListDate', () => {
  const receivedAt = '2026-08-20T12:00:00Z';

  it('shows when the mail arrived, not its Date header', () => {
    expect(emailListDate({ sentAt: '2026-08-20T09:00:00Z', receivedAt })).toBe(receivedAt);
  });

  it('keeps the Date header for mail that arrived long after it was sent (imports, #891)', () => {
    const sentAt = new Date(Date.parse(receivedAt) - MAX_DELIVERY_DELAY_MS - 1000).toISOString();
    expect(emailListDate({ sentAt, receivedAt })).toBe(sentAt);
  });

  it('falls back to the display date without a usable receivedAt', () => {
    expect(emailListDate({ sentAt: '2019-03-04T05:06:07Z' })).toBe('2019-03-04T05:06:07Z');
    expect(emailListDate({ sentAt: '2019-03-04T05:06:07Z', receivedAt: 'garbage' })).toBe('2019-03-04T05:06:07Z');
    expect(emailListDate({})).toBeUndefined();
  });
});
