import { describe, expect, it } from 'vitest';
import { measureEmailFrameHeight } from '../email-frame-height';

/**
 * jsdom has no layout, so each test pins the numbers a browser reports for a
 * frame of `frame` px holding `content` px of mail.
 */
function frameDoc({ frame, content }: { frame: number; content: number }): Document {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  const root = doc.documentElement;
  const body = doc.body;
  // The root's scrollHeight is the larger of the content and the viewport.
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => Math.max(content, frame) });
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => frame });
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => content });
  body.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 300, width: 300, bottom: content, height: content, toJSON: () => ({}),
  });
  return doc;
}

describe('measureEmailFrameHeight (#1474)', () => {
  it('shrinks a frame that is taller than its mail', () => {
    // The frame was sized 2400px while it was narrow; the mail now needs 600px.
    expect(measureEmailFrameHeight(frameDoc({ frame: 2400, content: 600 }))).toBe(600);
  });

  it('grows a frame that is shorter than its mail', () => {
    expect(measureEmailFrameHeight(frameDoc({ frame: 150, content: 900 }))).toBe(900);
  });

  it('keeps a frame that already fits', () => {
    expect(measureEmailFrameHeight(frameDoc({ frame: 600, content: 600 }))).toBe(600);
  });

  it('counts overflow past the body that only the root reports', () => {
    const doc = frameDoc({ frame: 150, content: 900 });
    Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, get: () => 1000 });
    expect(measureEmailFrameHeight(doc)).toBe(1000);
  });

  it('adds the body margin when the frame is taller than the mail', () => {
    const doc = frameDoc({ frame: 2400, content: 600 });
    doc.body.style.marginBottom = '16px';
    expect(measureEmailFrameHeight(doc)).toBe(616);
  });
});
