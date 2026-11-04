import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardWithUndo, showDraftSavedToast } from '../draft-close-toast';
import { useToastStore } from '@/stores/toast-store';

const labels = { saved: 'Draft saved', discard: 'Discard', discarded: 'Draft discarded', undo: 'Undo' };
const shown = () => useToastStore.getState().toasts;

describe('closing a composer that kept its draft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
    useToastStore.getState().clearToasts();
  });

  it('says "Draft saved" and offers Discard', () => {
    const discard = vi.fn();
    showDraftSavedToast(discard, labels);
    expect(shown()).toHaveLength(1);
    expect(shown()[0].title).toBe('Draft saved');
    expect(shown()[0].action?.label).toBe('Discard');
    expect(discard).not.toHaveBeenCalled();
  });

  it('deletes only once the Undo window is over', () => {
    const discard = vi.fn();
    showDraftSavedToast(discard, labels);
    shown()[0].action!.onClick();
    const undoToast = shown().find((t) => t.title === 'Draft discarded')!;
    expect(undoToast.action?.label).toBe('Undo');
    expect(undoToast.pauseOnHover).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(undoToast.duration!);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft on Undo and puts back what was taken away', () => {
    const discard = vi.fn();
    const restore = vi.fn();
    discardWithUndo(discard, labels, restore);
    shown()[0].action!.onClick();
    vi.advanceTimersByTime(60_000);
    expect(discard).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('deletes at once when the page goes away during the Undo window', () => {
    const discard = vi.fn();
    discardWithUndo(discard, labels);
    window.dispatchEvent(new Event('pagehide'));
    expect(discard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
