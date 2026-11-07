import { describe, it, expect } from 'vitest';
import { createFrameSizer } from '../email-frame-sizer';

// A stand-in for the mail document in its frame: the root's scroll height
// never drops below the frame's own height, the content's height is its own.
function fakeFrame(content: number, frame = 300) {
  const state = { content, frame, sizeReads: 0 };
  const sizer = createFrameSizer({
    sizes: () => { state.sizeReads++; return { width: 600, height: Math.max(state.frame, state.content), viewport: 600 }; },
    fit: () => 1,
    measure: () => state.content,
    write: (height) => { state.frame = height; },
    fitEnabled: () => false,
  });
  return { state, sizer };
}

describe('the mail frame sizer', () => {
  it('measures content that grows back to exactly the old frame height', () => {
    const { state, sizer } = fakeFrame(200);
    sizer(true);
    expect(state.frame).toBe(200);
    // Back to 300, the height the frame had before it was made shorter.
    state.content = 300;
    sizer();
    expect(state.frame).toBe(300);
  });

  it('reads the sizes once for a mail taller than the frame', () => {
    const { state, sizer } = fakeFrame(3000);
    sizer(true);
    expect(state.frame).toBe(3000);
    expect(state.sizeReads).toBe(1);
    // Nothing changed: nothing to do.
    sizer();
    expect(state.sizeReads).toBe(2);
    expect(state.frame).toBe(3000);
  });
});
