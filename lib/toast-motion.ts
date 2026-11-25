import type { CSSProperties } from "react";

export const TOAST_MOVE_MS = 260;
export const TOAST_LEAVE_MS = 220;
export const TOAST_FADE_MS = 140;
export const TOAST_STAGGER_MS = 30;
export const TOAST_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const POINTER_FOCUS_MS = 1000;

export const toastMotionVars = {
  "--toast-move": `${TOAST_MOVE_MS}ms`,
  "--toast-leave": `${TOAST_LEAVE_MS}ms`,
  "--toast-ease": TOAST_EASE,
} as CSSProperties;
