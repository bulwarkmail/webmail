import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DRAG_STALE_MS, startDragWatch } from '../drag-watch';
import type { DropFiles } from '../zones';
import { setOwnDragActive } from '@/lib/desktop/window-files';

/** jsdom has no DragEvent: an Event with the parts the watch reads. */
function drag(type: string, options: { files?: number; types?: string[]; itemTypes?: string[]; relatedTarget?: EventTarget | null; target?: EventTarget } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const count = options.files ?? 1;
  const types = options.types ?? (count > 0 ? ['Files'] : ['text/plain']);
  const items = (options.itemTypes ?? Array.from({ length: count }, () => '')).map((itemType) => ({ kind: 'file', type: itemType }));
  Object.defineProperty(event, 'dataTransfer', { value: { types, items, files: [], dropEffect: 'none' } });
  if ('relatedTarget' in options) Object.defineProperty(event, 'relatedTarget', { value: options.relatedTarget });
  (options.target ?? document.body).dispatchEvent(event);
  return event;
}

describe('noticing files dragged in from outside', () => {
  let enter: Mock<(files: DropFiles) => boolean>;
  let leave: Mock<() => void>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    enter = vi.fn((_files: DropFiles) => true);
    leave = vi.fn(() => {});
    stop = startDragWatch({ enter, leave });
  });

  afterEach(() => {
    stop();
    setOwnDragActive(false);
    vi.useRealTimers();
  });

  it('tells how many files and what kind, as far as the drag shows', () => {
    drag('dragenter', { files: 2, itemTypes: ['text/calendar', 'application/pdf'] });
    expect(enter).toHaveBeenCalledWith({ count: 2, kinds: ['calendar', 'other'], bytes: null });
  });

  it('a drag that started in the page is the app\'s own, not files from outside', () => {
    document.body.dispatchEvent(new Event('dragstart', { bubbles: true }));
    drag('dragenter');
    expect(enter).not.toHaveBeenCalled();
    // The first pointer event after a drag means it's over, even if dragend went nowhere.
    document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
    drag('dragenter');
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it('the app\'s own native drag of an attachment is not a new file either', () => {
    setOwnDragActive(true);
    drag('dragenter');
    expect(enter).not.toHaveBeenCalled();
  });

  it('text dragged around is no file', () => {
    drag('dragenter', { files: 0 });
    expect(enter).not.toHaveBeenCalled();
  });

  it('a component under the pointer does not get the first enter once the overlay takes it', () => {
    const inner = document.body.appendChild(document.createElement('div'));
    const seen = vi.fn();
    inner.addEventListener('dragenter', seen);
    drag('dragenter', { target: inner });
    expect(seen).not.toHaveBeenCalled();
    inner.remove();
  });

  it('leaving the window ends it; moving between elements does not', () => {
    drag('dragenter');
    drag('dragleave', { relatedTarget: document.body });
    expect(leave).not.toHaveBeenCalled();
    drag('dragleave', { relatedTarget: null });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('ends by itself when the drag goes quiet, as after Esc in some browsers', () => {
    drag('dragenter');
    vi.advanceTimersByTime(DRAG_STALE_MS / 2);
    drag('dragover');
    vi.advanceTimersByTime(DRAG_STALE_MS / 2);
    expect(leave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAG_STALE_MS);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('a drop anywhere ends it, and never lets the browser open the file instead of the app', async () => {
    drag('dragenter');
    const over = drag('dragover');
    expect(over.defaultPrevented).toBe(true);
    const dropped = drag('drop');
    expect(dropped.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('a drag the host turns down (locked, a dialog open) still cannot open the file in place of the app', () => {
    enter.mockReturnValue(false);
    drag('dragenter');
    expect(drag('dragover').defaultPrevented).toBe(true);
    expect(drag('drop').defaultPrevented).toBe(true);
    expect(leave).not.toHaveBeenCalled();
  });
});
