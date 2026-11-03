/**
 * The desktop app's menu bar, on the webmail's side. The shell shows the menu and
 * sends an id; what runs is the same handler the shortcut or button runs, from
 * whichever part of the app registered it. What's on screen decides what's enabled:
 * a surface reports that here, and the newest surface wins per command.
 *
 * Nothing happens in a browser: there's no bridge to publish to, and nobody sends
 * an id.
 */

import { useEffect, useRef } from 'react';
import { getDesktopBridge } from './bridge';
import type { DesktopMenuState } from './types';

export type DesktopCommandHandlers = Record<string, (() => void) | undefined>;

interface Surface {
  handlers: DesktopCommandHandlers;
  state: DesktopMenuState;
}

const surfaces = new Set<Surface>();
let base: DesktopMenuState = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** What the shell should show now: the base, with each surface over it, newest last. */
export function mergedDesktopState(): DesktopMenuState {
  const merged: DesktopMenuState = { ...base };
  for (const surface of surfaces) Object.assign(merged, surface.state);
  return merged;
}

function publish(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    getDesktopBridge()?.menu?.setState(mergedDesktopState());
  }, 30);
}

/** What holds whatever is on screen: signed in or not, the device policy. */
export function setDesktopBaseState(state: DesktopMenuState): void {
  base = state;
  publish();
}

/** Runs a command from the newest surface that has it. False when none does. */
export function runDesktopCommand(id: string): boolean {
  for (const surface of [...surfaces].reverse()) {
    const handler = surface.handlers[id];
    if (handler) {
      handler();
      return true;
    }
  }
  return false;
}

export function registerDesktopSurface(surface: Surface): () => void {
  surfaces.add(surface);
  publish();
  return () => {
    surfaces.delete(surface);
    publish();
  };
}

function sameState(a: DesktopMenuState, b: DesktopMenuState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * This part of the app answers these commands while `enabled`. Handlers can be new
 * on every render: the newest ones run, and only a changed state goes to the shell.
 */
export function useDesktopCommands(handlers: DesktopCommandHandlers, state: DesktopMenuState, enabled = true): void {
  const surfaceRef = useRef<Surface>({ handlers, state });
  surfaceRef.current.handlers = handlers;

  useEffect(() => {
    if (!enabled || !getDesktopBridge()?.menu) return;
    return registerDesktopSurface(surfaceRef.current);
  }, [enabled]);

  useEffect(() => {
    if (sameState(surfaceRef.current.state, state)) return;
    surfaceRef.current.state = state;
    publish();
  });
}

/** Test helper. */
export function resetDesktopCommands(): void {
  surfaces.clear();
  base = {};
  if (timer) clearTimeout(timer);
  timer = null;
}
