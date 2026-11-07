"use client";

import { useEffect, useState } from "react";

/** The longest the app's links wait for an idle moment before they prefetch anyway. */
export const START_PREFETCH_TIMEOUT_MS = 3000;

let ready = false;
let scheduled = false;
const waiting = new Set<() => void>();

function markReady(): void {
  ready = true;
  for (const wake of waiting) wake();
  waiting.clear();
}

function scheduleReady(): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(markReady, { timeout: START_PREFETCH_TIMEOUT_MS });
  } else {
    setTimeout(markReady, 0);
  }
}

/**
 * Whether the app's own links (the rail's Calendar, Contacts, Files, Settings)
 * may prefetch their routes yet. Not while the page starts: the mail view
 * rewrites "/" to its folder's address as it comes up, and Next prefetches
 * every visible link again when the address changes, so links that prefetched
 * before that sent each request twice, both while the first rows were still
 * on their way. From the first idle moment on they prefetch as before, and a
 * rail mounted later (another page) prefetches at once.
 */
export function usePrefetchAfterStart(): boolean {
  const [on, setOn] = useState(ready);
  useEffect(() => {
    if (ready) {
      setOn(true);
      return;
    }
    const wake = () => setOn(true);
    waiting.add(wake);
    if (!scheduled) {
      scheduled = true;
      scheduleReady();
    }
    return () => {
      waiting.delete(wake);
    };
  }, []);
  return on;
}
