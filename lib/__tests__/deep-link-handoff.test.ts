import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setPendingDeepLink,
  consumePendingDeepLink,
  subscribePendingDeepLink,
  clearPendingDeepLinks,
} from '@/lib/deep-link-handoff';

describe('deep-link handoff', () => {
  beforeEach(() => {
    clearPendingDeepLinks();
  });

  it('parks segments and yields them exactly once', () => {
    setPendingDeepLink('mail', ['message', 'abc']);
    expect(consumePendingDeepLink('mail')).toEqual(['message', 'abc']);
    expect(consumePendingDeepLink('mail')).toBeNull();
  });

  it('keeps surfaces separate', () => {
    setPendingDeepLink('mail', ['message', 'abc']);
    setPendingDeepLink('settings', ['folders']);
    expect(consumePendingDeepLink('settings')).toEqual(['folders']);
    expect(consumePendingDeepLink('mail')).toEqual(['message', 'abc']);
  });

  it('delivers live to a subscribed surface instead of parking', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDeepLink('mail', listener);

    setPendingDeepLink('mail', ['message', 'abc']);

    expect(listener).toHaveBeenCalledWith(['message', 'abc']);
    // Delivered, not parked: a later mount finds nothing.
    expect(consumePendingDeepLink('mail')).toBeNull();
    unsubscribe();
  });

  it('a listener only receives its own surface', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDeepLink('mail', listener);

    setPendingDeepLink('settings', ['folders']);

    expect(listener).not.toHaveBeenCalled();
    expect(consumePendingDeepLink('settings')).toEqual(['folders']);
    unsubscribe();
  });

  it('unsubscribing restores parking', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDeepLink('mail', listener);
    unsubscribe();

    setPendingDeepLink('mail', ['folder', 'inbox']);

    expect(listener).not.toHaveBeenCalled();
    expect(consumePendingDeepLink('mail')).toEqual(['folder', 'inbox']);
  });
});
