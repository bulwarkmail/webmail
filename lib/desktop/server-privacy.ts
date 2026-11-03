/**
 * The desktop user's telemetry and crash report consent, as the embedded server sees it.
 *
 * The Electron main process sends this at start and on every change (src/server/host.ts
 * in the desktop repo sets it on globalThis, which all of Next's bundles share, like the
 * list of trusted servers). Nothing in the renderer or the environment can write it.
 *
 * Only the desktop build reads it. No value means nobody has said yes: everything off.
 */

import { IS_DESKTOP_BUILD } from './flag';
import type { DesktopServerPrivacy } from './desktop-telemetry';

const PRIVACY_KEY = Symbol.for('bulwark.desktop.privacy');

export function desktopServerPrivacy(): DesktopServerPrivacy | null {
  if (!IS_DESKTOP_BUILD) return null;
  return (globalThis as unknown as Record<symbol, DesktopServerPrivacy | undefined>)[PRIVACY_KEY] ?? null;
}
