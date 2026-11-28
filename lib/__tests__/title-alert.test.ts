import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTitleAlertActive, startTitleAlert, stopTitleAlert, TITLE_ALERT_INTERVAL_MS, TITLE_ALERT_MAX_SWAPS,
} from '../title-alert';
import { setTitleBadge } from '../title-badge';

describe('title alert', () => {
  let focused = false;
  beforeEach(() => {
    vi.useFakeTimers();
    focused = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    document.title = 'Inbox';
  });
  afterEach(() => {
    stopTitleAlert();
    setTitleBadge(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('never swaps faster than once a second', () => {
    expect(TITLE_ALERT_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    startTitleAlert('1 new message');
    expect(document.title).toBe('1 new message');
    vi.advanceTimersByTime(999);
    expect(document.title).toBe('1 new message');
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS - 999);
    expect(document.title).toBe('Inbox');
  });

  it('stops by itself after a few rounds and puts the title back', () => {
    startTitleAlert('1 new message');
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS * TITLE_ALERT_MAX_SWAPS);
    expect(isTitleAlertActive()).toBe(false);
    expect(document.title).toBe('Inbox');
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS * 4);
    expect(document.title).toBe('Inbox');
  });

  it('stops when the tab gets the focus', () => {
    startTitleAlert('1 new message');
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(isTitleAlertActive()).toBe(false);
    expect(document.title).toBe('Inbox');
  });

  it('does nothing while the tab is in front', () => {
    focused = true;
    startTitleAlert('1 new message');
    expect(isTitleAlertActive()).toBe(false);
    expect(document.title).toBe('Inbox');
  });

  it('keeps the unread count at the front while it alerts, so a wrapper badge does not drop', () => {
    setTitleBadge(3);
    document.title = '(3) Inbox';
    startTitleAlert('1 new message');
    expect(document.title).toBe('(3) 1 new message');
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS);
    expect(document.title).toBe('(3) Inbox');
    setTitleBadge(4);
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS);
    expect(document.title).toBe('(4) 1 new message');
    vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS);
    expect(document.title).toBe('(4) Inbox');
    stopTitleAlert();
    expect(document.title).toBe('(4) Inbox');
  });

  it('shows a new count at once, not only at the next swap', () => {
    setTitleBadge(0);
    document.title = '(0) Inbox';
    startTitleAlert('1 new message');
    expect(document.title).toBe('(0) 1 new message');
    setTitleBadge(1);
    expect(document.title).toBe('(1) 1 new message');
  });
});
