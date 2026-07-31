"use client";

import { useEffect, useMemo, useState } from "react";

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
export function useShortenedText(
  candidates: string[],
): [(node: HTMLElement | null) => void, string] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<{ width: number; font: string } | null>(null);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const style = window.getComputedStyle(element);
      setBox({
        width: entry.contentRect.width,
        font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // Candidates are rebuilt on every render, so key the choice on their content.
  // They must not contain a newline, which keeps this join unambiguous.
  const key = candidates.join("\n");

  return [
    setElement,
    useMemo(() => {
      const options = key.split("\n");
      if (!box || box.width === 0) return options[0];
      return (
        options.find((option) => measureText(option, box.font) <= box.width)
        ?? options[options.length - 1]
      );
    }, [key, box]),
  ];
}
