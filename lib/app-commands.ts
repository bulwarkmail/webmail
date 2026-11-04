"use client";

// Commands the command palette hands to the surface that can run them (the
// mail page composes and searches). Loosely coupled through a window event,
// like the in-app mailto: requests, because that state lives deep inside the
// page component. When no surface takes a command, the palette parks it and
// navigates to mail, which runs it once it is ready.

import { useEffect, useRef } from 'react';

export type AppCommand = 'compose' | 'search' | 'all-inboxes' | 'show-list' | 'tour-end' | 'new-event' | 'new-task' | 'new-contact';

export const COMMAND_PALETTE_OPEN_EVENT = 'bulwark:command-palette';

/** Open the command palette from a button or menu (phones have no Ctrl+K). */
export function openCommandPalette(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

export const KEYBOARD_SHORTCUTS_OPEN_EVENT = 'bulwark:keyboard-shortcuts';

/** Open the keyboard shortcuts help, on the current app's section, like `?` does. */
export function openKeyboardShortcuts(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(KEYBOARD_SHORTCUTS_OPEN_EVENT));
}

const EVENT = 'bulwark:app-command';
let pending: AppCommand | null = null;

/** Run a command on a mounted surface. False when nothing took it. */
export function requestAppCommand(command: AppCommand): boolean {
  if (typeof window === 'undefined') return false;
  const uncancelled = window.dispatchEvent(new CustomEvent<AppCommand>(EVENT, { detail: command, cancelable: true }));
  return !uncancelled;
}

/** Keep a command for the next surface that registers a handler for it. */
export function parkAppCommand(command: AppCommand): void {
  pending = command;
}

/** Test helper. */
export function peekParkedAppCommand(): AppCommand | null {
  return pending;
}

/**
 * Let this surface run palette commands while `enabled`. A command parked
 * before the surface was ready runs as soon as it is.
 */
export function useAppCommands(handlers: Partial<Record<AppCommand, () => void>>, enabled: boolean): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onCommand = (event: Event) => {
      const handler = ref.current[(event as CustomEvent<AppCommand>).detail];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener(EVENT, onCommand);
    if (pending && ref.current[pending]) {
      const handler = ref.current[pending]!;
      pending = null;
      handler();
    }
    return () => window.removeEventListener(EVENT, onCommand);
  }, [enabled]);
}
