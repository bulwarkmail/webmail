/**
 * Sizes the reader's mail frame to its content (see EmailViewer).
 *
 * The scroll sizes of an untouched document cost nothing to read, so a call
 * whose sizes match the last measured ones does nothing. After the frame's
 * height is written they are read again only when the write can have changed
 * them: reading right after a write lays the whole mail out a second time,
 * which on a large newsletter was most of the open. A frame written to exactly
 * the document's scroll height leaves those sizes as they were; a frame made
 * shorter than the viewport was (short content) or a fit (phones) changes
 * them, and is read back so that content growing back to the old height is
 * still measured.
 */
export interface FrameSizes {
  width: number;
  height: number;
  viewport: number;
}

export interface FrameSizerParts {
  /** The document's scroll sizes and viewport width. */
  sizes: () => FrameSizes;
  /** Fit the mail to the width (phones); returns the scale applied. */
  fit: () => number;
  /** The content's height (measureEmailFrameHeight). */
  measure: () => number;
  /** Write the frame's height. */
  write: (height: number) => void;
  /** Whether the fit is on. */
  fitEnabled: () => boolean;
}

export function createFrameSizer(parts: FrameSizerParts): (force?: boolean) => void {
  let measured: FrameSizes = { width: -1, height: -1, viewport: -1 };
  return (force = false) => {
    const now = parts.sizes();
    if (!force && now.width === measured.width && now.height === measured.height && now.viewport === measured.viewport) return;
    // Shrink desktop-width mail to fit a phone screen first: it changes the
    // layout height, and the transform doesn't shrink the measured (layout)
    // height, so the frame box has to be scaled by hand.
    const scale = parts.fit();
    const height = Math.ceil(parts.measure() * scale);
    parts.write(height);
    measured = !parts.fitEnabled() && height === now.height ? now : parts.sizes();
  };
}
