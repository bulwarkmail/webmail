import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTitleBadge, setTitleBadge, subscribeTitleBadge, withTitleBadge } from '../title-badge';

afterEach(() => {
  setTitleBadge(null);
  document.title = '';
});

describe('title badge', () => {
  it('leaves the title alone when no count is to lead it', () => {
    expect(getTitleBadge()).toBeNull();
    expect(withTitleBadge('Inbox (3) - jane@example.com - Acme Mail')).toBe('Inbox (3) - jane@example.com - Acme Mail');
  });

  it('leads the title with the count, zero included, so the first brackets always hold it', () => {
    expect(withTitleBadge('Inbox - jane@example.com - Acme Mail', 3)).toBe('(3) Inbox - jane@example.com - Acme Mail');
    expect(withTitleBadge('Meeting (2pm) - Acme Mail', 0)).toBe('(0) Meeting (2pm) - Acme Mail');
    expect(withTitleBadge('Inbox', 133)).toBe('(133) Inbox');
  });

  it('uses the published count by default', () => {
    setTitleBadge(5);
    expect(getTitleBadge()).toBe(5);
    expect(withTitleBadge('Inbox')).toBe('(5) Inbox');
  });

  it('tells subscribers when the count changes, and only then', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTitleBadge(listener);
    setTitleBadge(2);
    setTitleBadge(2);
    expect(listener).toHaveBeenCalledTimes(1);
    setTitleBadge(null);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setTitleBadge(4);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reads a negative or broken count as zero', () => {
    setTitleBadge(-1);
    expect(withTitleBadge('Inbox')).toBe('(0) Inbox');
    setTitleBadge(Number.NaN);
    expect(withTitleBadge('Inbox')).toBe('(0) Inbox');
  });

  it('moves the count at the front of the title on, also when no page writes the title', () => {
    setTitleBadge(3);
    document.title = '(3) New message - jane@example.com - Acme Mail';
    setTitleBadge(4);
    expect(document.title).toBe('(4) New message - jane@example.com - Acme Mail');
  });

  it('puts the count in front of a title that has none yet', () => {
    document.title = 'Compose - Acme Mail';
    setTitleBadge(2);
    expect(document.title).toBe('(2) Compose - Acme Mail');
  });

  it('never touches a browser title, even one that starts with brackets', () => {
    document.title = '(2) tickets left - Acme Mail';
    setTitleBadge(null);
    expect(document.title).toBe('(2) tickets left - Acme Mail');
  });
});
