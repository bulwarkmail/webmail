"use client";

import { createContext, useContext } from "react";

// The words on the composer's bottom bar (Attach, Templates, Options,
// proofreading) show from a bar width on; below it only the icons do. A
// reply docked under its message keeps to icons up to a wider bar, so the
// bar stays one row next to Send (inline-reply). The class names are
// written out whole for Tailwind to find them.
const WIDE = { label: "hidden @[40rem]/composer-bar:inline", chevron: "hidden @[40rem]/composer-bar:block", count: "@[40rem]/composer-bar:hidden" };
const COMPACT = { label: "hidden @[64rem]/composer-bar:inline", chevron: "hidden @[64rem]/composer-bar:block", count: "@[64rem]/composer-bar:hidden" };

export type ComposerBarLabelClasses = typeof WIDE;

/** True inside a docked reply's bottom bar. */
export const ComposerBarCompactContext = createContext(false);

export function useComposerBarLabels(): ComposerBarLabelClasses {
  return useContext(ComposerBarCompactContext) ? COMPACT : WIDE;
}
