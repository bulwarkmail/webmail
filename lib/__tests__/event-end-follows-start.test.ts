import { describe, it, expect } from 'vitest';
import { shiftedEnd } from '@/components/calendar/event-modal';

const d = (s: string) => new Date(s);

describe('shiftedEnd (event editor: end follows start, keeping duration)', () => {
  it('moves the end forward by the same duration when start moves forward', () => {
    // 2h event 09:00-11:00, start -> 14:00  =>  end 16:00 (still 2h)
    expect(shiftedEnd(d('2026-03-01T09:00:00'), d('2026-03-01T11:00:00'), d('2026-03-01T14:00:00')))
      .toEqual(d('2026-03-01T16:00:00'));
  });

  it('moves the end backward by the same duration when start moves backward', () => {
    // 1h event 10:00-11:00, start -> 08:00  =>  end 09:00 (still 1h)
    expect(shiftedEnd(d('2026-03-01T10:00:00'), d('2026-03-01T11:00:00'), d('2026-03-01T08:00:00')))
      .toEqual(d('2026-03-01T09:00:00'));
  });

  it('preserves a multi-hour duration exactly', () => {
    // 90min event, start moved past the old end
    expect(shiftedEnd(d('2026-03-01T09:00:00'), d('2026-03-01T10:30:00'), d('2026-03-01T12:00:00')))
      .toEqual(d('2026-03-01T13:30:00'));
  });

  it('preserves a multi-day (all-day) duration', () => {
    // 2-day span, start -> 03-10  =>  end 03-12
    expect(shiftedEnd(d('2026-03-01T00:00:00'), d('2026-03-03T00:00:00'), d('2026-03-10T00:00:00')))
      .toEqual(d('2026-03-12T00:00:00'));
  });

  it('keeps a zero-length event zero-length', () => {
    expect(shiftedEnd(d('2026-03-01T10:00:00'), d('2026-03-01T10:00:00'), d('2026-03-01T15:00:00')))
      .toEqual(d('2026-03-01T15:00:00'));
  });

  it('returns null for an already-negative duration (does not amplify a bad state)', () => {
    expect(shiftedEnd(d('2026-03-01T11:00:00'), d('2026-03-01T10:00:00'), d('2026-03-01T14:00:00'))).toBeNull();
  });

  it('returns null for invalid dates', () => {
    expect(shiftedEnd(new Date('nope'), d('2026-03-01T11:00:00'), d('2026-03-01T09:00:00'))).toBeNull();
  });
});
