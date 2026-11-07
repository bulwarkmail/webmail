import { describe, expect, it } from 'vitest';
import { SUMMARY_FROM, shareNotificationToasts } from '../share-notification-toaster';
import type { ShareNotification } from '@/lib/jmap/types';

const notification = (id: string, over: Partial<ShareNotification> = {}): ShareNotification => ({
  id,
  created: '2026-11-06T06:19:42Z',
  changedBy: { name: 'Alice', email: 'alice@example.com', principalId: 'p1' },
  objectType: 'Calendar',
  objectAccountId: 'owner',
  objectId: 'b',
  name: 'Team',
  oldRights: null,
  newRights: { mayReadFreeBusy: true },
  ...over,
});

const bob = { name: 'Bob', email: 'bob@example.com', principalId: 'p2' };
const none = () => undefined;

describe('shareNotificationToasts', () => {
  it('shows a few named notifications one by one', () => {
    const toasts = shareNotificationToasts([notification('n1'), notification('n2')], none);
    expect(toasts.map((t) => t.type)).toEqual(['single', 'single']);
  });

  it('sums up one person changing many at once', () => {
    const many = Array.from({ length: SUMMARY_FROM }, (_, i) => notification(`n${i}`));
    const toasts = shareNotificationToasts([...many, notification('x', { changedBy: bob })], none);
    expect(toasts).toEqual([
      { type: 'summary', changedBy: many[0].changedBy, count: SUMMARY_FROM, revoked: false },
      expect.objectContaining({ type: 'single', object: 'Team' }),
    ]);
  });

  it('takes a name the server left out from the lists', () => {
    const toasts = shareNotificationToasts([notification('n1', { name: '' })], () => 'Persönlich');
    expect(toasts).toEqual([expect.objectContaining({ type: 'single', object: 'Persönlich' })]);
  });

  it('never shows a bare object id: no name anywhere sums up', () => {
    const toasts = shareNotificationToasts([notification('n1', { name: '' })], none);
    expect(toasts).toEqual([
      { type: 'summary', changedBy: expect.objectContaining({ name: 'Alice' }), count: 1, revoked: false },
    ]);
  });

  it('warns when every change of the summary took access away', () => {
    const gone = { oldRights: { mayReadFreeBusy: true }, newRights: null };
    const many = Array.from({ length: SUMMARY_FROM }, (_, i) => notification(`n${i}`, gone));
    expect(shareNotificationToasts(many, none)).toEqual([expect.objectContaining({ revoked: true })]);
  });
});
