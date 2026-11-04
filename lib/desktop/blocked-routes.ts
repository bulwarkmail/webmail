/**
 * Routes with no meaning in the desktop build: pairing a phone and the mobile
 * hand-off both hand out `https://app.bulwark.localhost`, which nothing else
 * can reach, and the app has no use for impersonation. proxy.ts answers 404.
 */
const BLOCKED = /^\/api\/auth\/(pair|handoff|desktop-handoff|impersonate)(\/|$)/;

export function isDesktopBlockedRoute(pathname: string): boolean {
  return BLOCKED.test(pathname);
}
