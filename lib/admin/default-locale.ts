import { configManager } from './config-manager';
import { routing, type Locale } from '@/i18n/routing';

/**
 * The locale a visitor gets when neither their cookie nor Accept-Language
 * picks a supported one: the admin/env `defaultLocale` when set to a locale
 * we ship, else the build-time default. Server only; configManager must have
 * been loaded (every request path calls ensureLoaded() first).
 */
export function resolveDefaultLocale(): Locale {
  // config.json is hand-editable, so the stored value may not be a string.
  const raw = configManager.get<unknown>('defaultLocale', '');
  const configured = typeof raw === 'string' ? raw.trim() : '';
  return (routing.locales as readonly string[]).includes(configured)
    ? (configured as Locale)
    : routing.defaultLocale;
}
