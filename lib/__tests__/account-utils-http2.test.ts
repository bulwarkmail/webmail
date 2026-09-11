import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMaxAccounts, MAX_ACCOUNT_SLOTS } from '../account-utils';
afterEach(() => vi.restoreAllMocks());
describe('account limit protocol detection', () => {
  it('recognizes HTTP/2 from document navigation before resources load', () => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(type => type === 'navigation' ? [{ nextHopProtocol: 'h2' } as PerformanceResourceTiming] : []);
    expect(getMaxAccounts()).toBe(MAX_ACCOUNT_SLOTS);
  });
  it('retains the conservative cap when no multiplexed protocol was observed', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ nextHopProtocol: 'http/1.1' } as PerformanceResourceTiming]);
    expect(getMaxAccounts()).toBe(5);
  });
});
