import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printPdfUrl } from '../print-pdf';

// A PDF prints through the browser's own PDF viewer, from a frame off screen
// that holds just the PDF, so the dialog shows its pages and not the app.

describe('printPdfUrl', () => {
  let printed: number;

  beforeEach(() => {
    vi.useFakeTimers();
    printed = 0;
    // jsdom loads no PDF: load the frame once it is attached, and count print().
    vi.spyOn(document.body, 'appendChild').mockImplementation(function (this: HTMLElement, node: Node) {
      HTMLElement.prototype.appendChild.call(this, node);
      if (node instanceof HTMLIFrameElement) {
        node.contentWindow!.print = () => { printed += 1; };
        queueMicrotask(() => node.dispatchEvent(new Event('load')));
      }
      return node;
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('iframe').forEach((f) => f.remove());
  });

  it('prints the PDF from a frame of its own, laid out off screen, and cleans up', async () => {
    const done = printPdfUrl('blob:https://mail.example/pdf-1');
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('blob:https://mail.example/pdf-1');
    expect(frame.style.display).not.toBe('none');
    expect(frame.style.left).toBe('-10000px');
    expect(await done).toBe(true);
    expect(printed).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
