// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cancelHeldSend, releaseHeldSend, resetHeldSends, whenSent } from '../send-settled';

beforeEach(() => {
  vi.useFakeTimers();
  resetHeldSends();
});
afterEach(() => vi.useRealTimers());

const held = (id = 's1') => ({ scheduled: true, emailSubmissionId: id, sendAt: new Date(Date.now() + 10_000).toISOString() });

describe('whenSent', () => {
  it('runs at once for a plain send', () => {
    const followUp = vi.fn();
    whenSent({ scheduled: false, emailSubmissionId: 's1' }, followUp);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('runs at once for a send the user scheduled', () => {
    const followUp = vi.fn();
    whenSent({ scheduled: true, emailSubmissionId: 's1', sendAt: '2030-01-01T08:00:00Z' }, followUp, { scheduledByUser: true });
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('waits out the undo hold', () => {
    const followUp = vi.fn();
    whenSent(held(), followUp);
    vi.advanceTimersByTime(9_000);
    expect(followUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('runs every follow-up of one send, in order, on one timer', () => {
    const order: string[] = [];
    whenSent(held(), () => order.push('plugin'));
    whenSent(held(), () => order.push('archive'));
    vi.advanceTimersByTime(10_000);
    expect(order).toEqual(['plugin', 'archive']);
  });

  it('runs on "Send now", once', () => {
    const followUp = vi.fn();
    whenSent(held(), followUp);
    releaseHeldSend('s1');
    expect(followUp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('never runs for an undone send', () => {
    const followUp = vi.fn();
    whenSent(held(), followUp);
    cancelHeldSend('s1');
    vi.advanceTimersByTime(20_000);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('settling one hold leaves the others', () => {
    const first = vi.fn();
    const second = vi.fn();
    whenSent(held('s1'), first);
    whenSent(held('s2'), second);
    cancelHeldSend('s1');
    vi.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never runs for a send waiting in the offline outbox', () => {
    const followUp = vi.fn();
    whenSent({ scheduled: false, queued: true }, followUp);
    vi.advanceTimersByTime(20_000);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('one follow-up failing does not stop the next', () => {
    const next = vi.fn();
    whenSent(held(), () => { throw new Error('boom'); });
    whenSent(held(), next);
    vi.advanceTimersByTime(10_000);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
