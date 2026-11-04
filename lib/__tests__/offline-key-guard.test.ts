import { describe, expect, it, vi } from 'vitest';
import { guardOfflineMailChanges } from '../offline-key-guard';

describe('keys that change mail, offline', () => {
  it('answer with the refusal instead of running, and run again once they can', () => {
    let can = false;
    const archive = vi.fn();
    const next = vi.fn();
    const refused = vi.fn();
    const handlers = guardOfflineMailChanges({ onArchive: archive, onNextEmail: next }, () => can, refused);
    handlers.onArchive();
    expect(archive).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledTimes(1);
    handlers.onNextEmail();
    expect(next).toHaveBeenCalledTimes(1);
    can = true;
    handlers.onArchive();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('leaves a key with no handler without one', () => {
    const handlers = guardOfflineMailChanges({ onArchive: undefined as (() => void) | undefined }, () => false, vi.fn());
    expect(handlers.onArchive).toBeUndefined();
  });
});
