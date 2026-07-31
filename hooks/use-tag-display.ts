"use client";

import { createContext, useContext, useEffect, useMemo, useState, type RefObject } from "react";
import type { TagBadgeVariant } from "@/components/email/tag-badge";

/**
 * Below this, a named tag beside the subject would leave the subject nothing to
 * occupy, so tags move up to the sender line instead. The split list runs
 * 240-600px wide and defaults to 384, so it reads that way until widened, while
 * the full-width focus and bottom-pane layouts keep tags with the subject.
 */
const TAG_BESIDE_SUBJECT_MIN_WIDTH = 560;

/**
 * Below this there is no room to name a tag anywhere on the row, and colour
 * alone has to carry it. Well under the split list's default, because the
 * sender line still has room for a name long after the subject line does not.
 */
const TAG_NAME_MIN_WIDTH = 320;

export interface TagDisplay {
  /** Whether a tag is named or shown as colour alone. */
  variant: TagBadgeVariant;
  /** Which line of a multi-line row the tags belong on. */
  placement: "subject" | "sender";
}

const NAMED_BESIDE_SUBJECT: TagDisplay = { variant: "badge", placement: "subject" };

/**
 * How message rows should draw their tags.
 *
 * One value for the whole list, never per row: rows are all the same width, so
 * measuring each would burn a `ResizeObserver` per virtualised row and, worse,
 * let neighbours disagree - one naming its tags while the next showed dots.
 */
export const TagDisplayContext = createContext<TagDisplay>(NAMED_BESIDE_SUBJECT);

export function useTagDisplay(): TagDisplay {
  return useContext(TagDisplayContext);
}

/**
 * Watches a container and reports what its rows have room for. Falls back to
 * naming tags beside the subject where measurement is unavailable - server
 * rendering, and jsdom under test - since that is the most informative form.
 */
export function useMeasuredTagDisplay(ref: RefObject<HTMLElement | null>): TagDisplay {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return useMemo(() => {
    if (width === null) return NAMED_BESIDE_SUBJECT;
    return {
      variant: width >= TAG_NAME_MIN_WIDTH ? "badge" : "dot",
      placement: width >= TAG_BESIDE_SUBJECT_MIN_WIDTH ? "subject" : "sender",
    };
  }, [width]);
}
