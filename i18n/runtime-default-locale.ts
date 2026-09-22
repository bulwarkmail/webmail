import { routing } from './routing';

// Client-side mirror of the server's resolved fallback locale (admin/env
// `defaultLocale`, see lib/admin/default-locale.ts). Filled in from
// /api/config; until then, and on the static Lite build, the build-time
// default applies.
let runtimeDefaultLocale: string | null = null;

export function setRuntimeDefaultLocale(locale: unknown): void {
  runtimeDefaultLocale =
    typeof locale === 'string' && (routing.locales as readonly string[]).includes(locale) ? locale : null;
}

/** The fallback locale in effect for this deployment. */
export function getDefaultLocale(): string {
  return runtimeDefaultLocale ?? routing.defaultLocale;
}
