"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from "react";
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

/**
 * Below this, a sender line with several tags or a folder chip leaves the
 * sender's name a letter or two, so the tags give way to their dots.
 */
const SENDER_LINE_TIGHT_WIDTH = 480;

export interface TagDisplay {
  /** Whether a tag is named or shown as colour alone. */
  variant: TagBadgeVariant;
  /** Which line of a multi-line row the tags belong on. */
  placement: "subject" | "sender";
  /** The sender line can't also hold a crowd of named tags and chips. */
  tight: boolean;
}

const NAMED_BESIDE_SUBJECT: TagDisplay = { variant: "badge", placement: "subject", tight: false };

/**
 * How message rows should draw their tags.
 *
 * One value for the whole list, never per row: rows are all the same width, so
 * measuring each would burn a `ResizeObserver` per virtualised row and, worse,
 * let neighbours disagree - one naming its tags while the next showed dots.
 */
export const TagDisplayContext = createContext<TagDisplay>(NAMED_BESIDE_SUBJECT);

/**
 * The list's measured tag display as a source rows read from: only the rows
 * that draw tags or a folder chip follow it. As a plain context value, the
 * first measurement after the rows mounted (and any later change of width
 * class) drew every row on screen again, though most rows draw no tag.
 */
export interface TagDisplaySource {
  get(): TagDisplay;
  subscribe(onChange: () => void): () => void;
}

export const TagDisplaySourceContext = createContext<TagDisplaySource | null>(null);

const noSubscription = () => () => {};

export function useTagDisplay(): TagDisplay {
  return useRowTagDisplay(true);
}

/**
 * useTagDisplay for a row that only needs the display when `needed` (it has
 * tags or a folder chip to draw); otherwise it gets the default and is not
 * drawn again when the list's width class changes.
 */
export function useRowTagDisplay(needed: boolean): TagDisplay {
  const fixed = useContext(TagDisplayContext);
  const source = useContext(TagDisplaySourceContext);
  const read = () => (source && needed ? source.get() : fixed);
  return useSyncExternalStore(source && needed ? source.subscribe : noSubscription, read, read);
}

function displayFor(width: number | null): TagDisplay {
  if (width === null) return NAMED_BESIDE_SUBJECT;
  const variant: TagBadgeVariant = width >= TAG_NAME_MIN_WIDTH ? "badge" : "dot";
  const placement = width >= TAG_BESIDE_SUBJECT_MIN_WIDTH ? "subject" : "sender";
  const tight = width < SENDER_LINE_TIGHT_WIDTH;
  // One object per combination, so a width change inside a class is no change.
  const key = `${variant}|${placement}|${tight}`;
  let display = DISPLAYS.get(key);
  if (!display) {
    display = { variant, placement, tight };
    DISPLAYS.set(key, display);
  }
  return display;
}
const DISPLAYS = new Map<string, TagDisplay>();

/**
 * useMeasuredTagDisplay as a TagDisplaySource for TagDisplaySourceContext:
 * the object stays the same, its value follows the container's width.
 */
export function useMeasuredTagDisplaySource(ref: RefObject<HTMLElement | null>): TagDisplaySource {
  const [source] = useState(() => {
    let current = NAMED_BESIDE_SUBJECT;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => { listeners.delete(onChange); };
      },
      set(next: TagDisplay) {
        if (next === current) return;
        current = next;
        listeners.forEach((listener) => listener());
      },
    };
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined) source.set(displayFor(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, source]);

  return source;
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
      tight: width < SENDER_LINE_TIGHT_WIDTH,
    };
  }, [width]);
}
