/**
 * Prefix API paths with the configured basePath.
 *
 * Next.js's `basePath` config does not automatically prefix `fetch()` calls.
 * This helper ensures client-side API requests target the correct URL when
 * Bulwark is hosted under a sub-path (e.g. `/webmail`).
 *
 * Set `NEXT_PUBLIC_BASE_PATH` (e.g. `"/webmail"`) to serve under a sub-path.
 * When unset, paths are returned unchanged.
 *
 * @example
 *   fetch(apiPath("/api/auth/session"))  // → /webmail/api/auth/session
 */
export function apiPath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!basePath) return path;
  if (path.startsWith(basePath)) return path;
  return `${basePath}${path}`;
}
