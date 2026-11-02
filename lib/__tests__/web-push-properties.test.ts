import { describe, expect, it } from 'vitest';
import { EMAIL_PUSH_PROPERTIES } from '@/lib/web-push';

// The emailPush subscription goes through the push service: it may carry
// ids only. With from, subject or preview here, they would reach the push
// service around the device policy "Push without sender and subject",
// whose text the server holds back in app/api/push/preview.
describe('EMAIL_PUSH_PROPERTIES', () => {
  it('stays id and threadId', () => {
    expect([...EMAIL_PUSH_PROPERTIES]).toEqual(['id', 'threadId']);
  });
});
