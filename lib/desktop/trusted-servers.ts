/**
 * The mail servers the user approved in the desktop app.
 *
 * The Electron main process owns this list and sends it to the embedded server
 * at start and on every change (src/server/host.ts in the desktop repo sets it
 * on globalThis, which all of Next's bundles share). Nothing in the renderer
 * or the environment can write it, so script in a page can't aim the login
 * routes at the LAN.
 *
 * Callers guard this with IS_DESKTOP_BUILD, so a server build compiles the
 * whole thing away. scripts/standalone-guard.mjs checks that it did.
 */

type TrustedOrigins = ReadonlySet<string>;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isDesktopTrustedServer(url: string | null | undefined): boolean {
  if (!url) return false;
  const origin = originOf(url);
  if (!origin) return false;
  const holder = globalThis as unknown as Record<symbol, TrustedOrigins | undefined>;
  return holder[Symbol.for('bulwark.desktop.trustedJmapOrigins')]?.has(origin) === true;
}
