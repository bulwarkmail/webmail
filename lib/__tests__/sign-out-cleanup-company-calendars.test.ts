import { describe, expect, it, vi } from 'vitest';
import { purgeSignedOutData } from '../sign-out-cleanup';

// The company calendar cache (lib/company-calendars.ts) goes on a full
// sign-out even in a tab that never loaded the calendar: this file doesn't
// import it.

describe('purgeSignedOutData', () => {
  it('deletes the stored company calendars by name', () => {
    const deleteDatabase = vi.fn();
    Object.defineProperty(window, 'indexedDB', { value: { deleteDatabase }, configurable: true });
    try {
      purgeSignedOutData();
      expect(deleteDatabase).toHaveBeenCalledWith('bulwark-company-calendars');
    } finally {
      delete (window as unknown as Record<string, unknown>).indexedDB;
    }
  });
});
