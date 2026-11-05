import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { mergeEchoes, nextSendTime, raiseThreadCount, scheduledShownTotal, sentEcho } from '../held-send';

// mail-p3 (p2-1 left over): for about 15 s after "Sent" the reply's card
// carried a scheduled clock, Scheduled counted 1, and the list row kept the
// old message count.

const now = Date.parse('2026-11-04T10:00:00Z');
const at = (ms: number) => new Date(now + ms).toISOString();

describe('the server copy of a reply just sent', () => {
  const echo = sentEcho({ emailId: 'c', threadId: 't', to: ['sam@example.org'], subject: 'Re: x', text: 'Thanks' });
  const held = { id: 'c', isScheduled: true, scheduledSendAt: at(8000), scheduledUndoStatus: 'pending' } as Email;

  it('takes the echo\'s place without a scheduled clock', () => {
    const [merged] = mergeEchoes([held], [echo], now);
    expect(merged.sentEcho).toBeFalsy();
    expect(merged.isScheduled).toBe(false);
    expect(merged.scheduledSendAt).toBeUndefined();
  });

  it('stays without one on the next read, while the server still holds it', () => {
    const [first] = mergeEchoes([held], [echo], now);
    const [second] = mergeEchoes([held], [first], now + 2000);
    expect(second.isScheduled).toBe(false);
  });

  it('leaves a message really scheduled for later as it is', () => {
    const later = { id: 'd', isScheduled: true, scheduledSendAt: at(3 * 3600_000) } as Email;
    expect(mergeEchoes([later], [later], now)[0].isScheduled).toBe(true);
    // Also when it was on screen unscheduled a moment before: it isn't a held send.
    expect(mergeEchoes([later], [{ id: 'd' } as Email], now)[0].isScheduled).toBe(true);
  });
});

describe('scheduledShownTotal', () => {
  it('leaves out sends whose time has come', () => {
    const sends = [{ sendAt: at(-2000), undoStatus: 'pending' }, { sendAt: at(3600_000), undoStatus: 'pending' }];
    expect(scheduledShownTotal(2, sends, now)).toBe(1);
    expect(scheduledShownTotal(2, sends, now - 5000)).toBe(2);
    expect(scheduledShownTotal(0, sends, now)).toBe(0);
  });

  it('finds the next send time to look again at', () => {
    expect(nextSendTime([{ sendAt: at(-1) }, { sendAt: at(9000) }, { sendAt: at(5000) }], now)).toBe(now + 5000);
    expect(nextSendTime([{ sendAt: at(-1) }], now)).toBeNull();
  });
});

describe('raiseThreadCount', () => {
  it('raises a row\'s count to what the conversation holds, never lowers it', () => {
    const counts = new Map([['t', 4]]);
    expect(raiseThreadCount(counts, 't', 5)!.get('t')).toBe(5);
    expect(raiseThreadCount(counts, 't', 3)).toBeNull();
    expect(raiseThreadCount(counts, 'u', 2)!.get('u')).toBe(2);
  });
});
