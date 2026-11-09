import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTabReply, takeTabReply, useNotificationTabReply } from '../tab-reply';

afterEach(() => {
  vi.useRealTimers();
  useNotificationTabReply.setState({ pending: null });
});

describe('a notification reply waiting for its Pro tab', () => {
  it('reaches that message once, with the text', () => {
    requestTabReply('e1', 'Thanks');
    expect(takeTabReply('e1')).toBe('Thanks');
    expect(takeTabReply('e1')).toBeNull();
  });

  it('keeps an empty reply apart from none', () => {
    requestTabReply('e1', '');
    expect(takeTabReply('e1')).toBe('');
  });

  it('stays for its own message when another tab loads', () => {
    requestTabReply('e1', 'Thanks');
    expect(takeTabReply('e2')).toBeNull();
    expect(takeTabReply('e1')).toBe('Thanks');
  });

  it("doesn't open a composer minutes later", () => {
    vi.useFakeTimers();
    requestTabReply('e1', 'Thanks');
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(takeTabReply('e1')).toBeNull();
  });
});
