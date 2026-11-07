"use client";

import { useEffect, useState } from "react";

/** How long links on the bare app root wait for the mail view's address before they prefetch anyway. */
export const START_PREFETCH_TIMEOUT_MS = 5000;

let ready = false;

/**
 * Whether the app's own links (the rail's Calendar, Contacts, Files, Settings)
 * may prefetch their routes yet. Not on the bare app root while the page
 * starts: the mail view rewrites "/" to its folder's address as it comes up,
 * and Next prefetches every visible link again when the address changes, so
 * links that prefetched before that sent each request twice, while the first
 * rows were still on their way. Once the address has moved on (or after
 * START_PREFETCH_TIMEOUT_MS on "/") they prefetch as before, and so does any
 * rail mounted later.
 */
export function usePrefetchAfterStart(pathname: string): boolean {
  const atRoot = pathname === "/";
  const [timedOut, setTimedOut] = useState(false);
  if (!atRoot) ready = true;
  useEffect(() => {
    if (ready || !atRoot) return;
    const timer = setTimeout(() => {
      ready = true;
      setTimedOut(true);
    }, START_PREFETCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [atRoot]);
  return ready || timedOut || !atRoot;
}
