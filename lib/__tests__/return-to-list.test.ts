import { describe, it, expect } from 'vitest';
import { effectiveReturnToList, listBesideReader } from '../return-to-list';

// "Return to list after…": left alone it follows the layout (next message
// with the list beside the reader, back to the list elsewhere); set by the
// user or the admin, it decides everywhere.

const untouched = { returnToListAfterAction: true, explicitSettings: [] as string[] };
const chosen = (value: boolean) => ({ returnToListAfterAction: value, explicitSettings: ['returnToListAfterAction'] });

describe('listBesideReader', () => {
  const desktop = { isMobile: false, interfaceLayout: 'default' as const };
  it('is true for the split and horizontal layouts on a desktop', () => {
    expect(listBesideReader({ ...desktop, mailLayout: 'split' })).toBe(true);
    expect(listBesideReader({ ...desktop, mailLayout: 'horizontal' })).toBe(true);
  });
  it('is false where the message takes the list’s place', () => {
    expect(listBesideReader({ ...desktop, mailLayout: 'focus' })).toBe(false);
    expect(listBesideReader({ ...desktop, mailLayout: 'split', interfaceLayout: 'mountain-view' })).toBe(false);
    expect(listBesideReader({ ...desktop, mailLayout: 'split', simpleMode: true })).toBe(false);
    expect(listBesideReader({ ...desktop, mailLayout: 'split', isMobile: true })).toBe(false);
  });
});

describe('effectiveReturnToList', () => {
  it('opens the next message beside the reader while nobody set it', () => {
    expect(effectiveReturnToList(untouched, true, false)).toBe(false);
  });
  it('goes back to the list elsewhere while nobody set it', () => {
    expect(effectiveReturnToList(untouched, false, false)).toBe(true);
  });
  it('follows the user’s choice on every layout', () => {
    expect(effectiveReturnToList(chosen(true), true, false)).toBe(true);
    expect(effectiveReturnToList(chosen(false), false, false)).toBe(false);
  });
  it('follows an admin preset or lock', () => {
    expect(effectiveReturnToList(untouched, true, true)).toBe(true);
    expect(effectiveReturnToList({ ...untouched, returnToListAfterAction: false }, false, true)).toBe(false);
  });
});
