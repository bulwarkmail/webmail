"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Measures text the way the browser will, using the font the element actually
 * renders with. One canvas is reused for every measurement.
 */
let measureContext: CanvasRenderingContext2D | null | undefined;

function measureText(text: string, font: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Picks the first of `candidates` that fits the element the returned ref is
 * attached to, remeasuring whenever that element is resized.
 *
 * Candidates run longest first, so the result is the most complete one there is
 * room for. A character budget cannot do this job: the columns this is used in
 * are resized by the user and share their row with controls whose width depends
 * on the locale, so any fixed number is either so generous that it never
 * triggers or so tight that it shortens text that would have fit.
 *
 * Attach the ref to an element whose width does *not* depend on its own text -
 * a flex child that is allowed to shrink, i.e. one with `truncate` or
 * `min-w-0`. On anything else, picking a shorter candidate would change the
 * width that picked it and the two would oscillate.
 *
 * Where measurement is unavailable - server rendering, and jsdom under test -
 * this returns the first candidate, so the text is complete rather than
 * arbitrarily shortened.
 */
interface Box {
  width: number;
  font: string;
}

/** The first of the candidates (joined by newlines) that fits `box`. */
function pick(key: string, box: Box | null): string {
  const options = key.split("\n");
  if (!box || box.width === 0) return options[0];
  return (
    options.find((option) => measureText(option, box.font) <= box.width)
    ?? options[options.length - 1]
  );
}

export function useShortenedText(
  candidates: string[],
): [(node: HTMLElement | null) => void, string] {
  // Candidates are rebuilt on every render, so key the choice on their content.
  // They must not contain a newline, which keeps this join unambiguous.
  const key = candidates.join("\n");
  const keyRef = useRef(key);
  keyRef.current = key;
  // The measured box, and a copy in state that changes only when it changes
  // the text shown: the sidebar has a dozen of these, and setting state for
  // each measurement (first the element, then its size) drew every folder
  // row twice more after it mounted, though nearly every name fits.
  const latestBox = useRef<Box | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const shown = useRef("");
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);

  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const style = window.getComputedStyle(element);
      const measured = {
        width: entry.contentRect.width,
        font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      };
      latestBox.current = measured;
      if (pick(keyRef.current, measured) !== shown.current) setBox(measured);
    });
    observer.current = next;
    next.observe(element);
  }, []);

  // `box` only says the choice changed; the latest measurement is the one to use.
  const text = useMemo(() => pick(key, latestBox.current ?? box), [key, box]);
  shown.current = text;
  return [ref, text];
}
