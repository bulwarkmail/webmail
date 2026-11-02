import { describe, expect, it } from 'vitest';
import { storageSummary } from '@/app/(main)/admin/_pages/dashboard';

describe('storageSummary (admin overview)', () => {
  it('names local files for a single instance', () => {
    expect(storageSummary({ mode: 'local', location: 'local files', instances: 1 })).toEqual({ value: 'Local files on this server' });
  });

  it('names the shared store and how many instances checked in', () => {
    expect(storageSummary({ mode: 'redis', location: 'redis://valkey:6379/0', instances: 3 })).toEqual({
      value: 'Shared store, 3 instances checked in during the last minute',
      description: 'redis://valkey:6379/0',
    });
    expect(storageSummary({ mode: 'redis', location: 'redis://v:6379/0', instances: 1 }).value).toBe('Shared store, 1 instance checked in during the last minute');
  });

  it('says when the store is unreachable', () => {
    expect(storageSummary({ mode: 'redis', location: 'redis://v:6379/0', instances: null }).value).toBe('Shared store, store unreachable');
  });
});
