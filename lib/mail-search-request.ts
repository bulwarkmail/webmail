"use client";

// A mail search asked for from outside the mail page's search box: "Find
// emails from …" on an address in a message, "Search mail for …" on selected
// text in the desktop app. Through a window event, like lib/app-commands,
// since the search state lives deep inside the mail page. A request nobody
// takes waits for the next mail page that mounts.

import { useEffect, useRef } from 'react';

export type MailSearchRequest = { from: string } | { text: string };

const EVENT = 'bulwark:mail-search';
let pending: MailSearchRequest | null = null;
let listening = 0;

/** Whether a mail page in this window takes searches now. */
export function mailSearchAvailable(): boolean {
  return listening > 0;
}

/** Runs a search on the mail page. False when no mail page took it. */
export function requestMailSearch(request: MailSearchRequest): boolean {
  if (typeof window === 'undefined') return false;
  return !window.dispatchEvent(new CustomEvent<MailSearchRequest>(EVENT, { detail: request, cancelable: true }));
}

/** Keeps a search for the next mail page, for a caller that is about to go there. */
export function parkMailSearch(request: MailSearchRequest): void {
  pending = request;
}

/** The mail page's side: runs the searches asked for while `enabled`. */
export function useMailSearchRequests(run: (request: MailSearchRequest) => void, enabled: boolean): void {
  const ref = useRef(run);
  useEffect(() => {
    ref.current = run;
  });

  useEffect(() => {
    if (!enabled) return;
    const onRequest = (event: Event) => {
      event.preventDefault();
      ref.current((event as CustomEvent<MailSearchRequest>).detail);
    };
    window.addEventListener(EVENT, onRequest);
    listening += 1;
    if (pending) {
      const request = pending;
      pending = null;
      ref.current(request);
    }
    return () => {
      window.removeEventListener(EVENT, onRequest);
      listening -= 1;
    };
  }, [enabled]);
}
