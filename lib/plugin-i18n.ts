// Plugin i18n registry - manages per-plugin translation tables
//
// Each plugin gets its own namespace keyed by:
//   pluginId → locale → { messageKey → translated string }
//
// Resolution order when calling t(key):
//   1. Exact locale match         ("fr-CA")
//   2. Language-prefix match      ("fr"  from "fr-CA")
//   3. English fallback           ("en")
//   4. Raw key                    (plugin is never broken by missing strings)
//
// Interpolation uses {paramName} placeholders.

// ─── Registry ────────────────────────────────────────────────

/** pluginId → locale → key → translated string */
const registry = new Map<string, Map<string, Record<string, string>>>();

let currentLocale = 'en';

// ─── Locale sync (called by plugin-loader) ───────────────────

/** Keep the registry in sync with the app locale */
export function setPluginI18nLocale(locale: string): void {
  currentLocale = locale;
}

export function getPluginI18nLocale(): string {
  return currentLocale;
}

// ─── Cleanup ─────────────────────────────────────────────────

/** Remove all translations for a plugin (called on deactivation) */
export function clearPluginI18nTranslations(pluginId: string): void {
  registry.delete(pluginId);
}

// ─── Helpers ─────────────────────────────────────────────────

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function resolve(pluginId: string, key: string): string | undefined {
  const byLocale = registry.get(pluginId);
  if (!byLocale) return undefined;

  // 1. Exact locale (e.g. "fr-CA")
  const exact = byLocale.get(currentLocale)?.[key];
  if (exact !== undefined) return exact;

  // 2. Language prefix (e.g. "fr" from "fr-CA")
  const lang = currentLocale.split('-')[0];
  if (lang !== currentLocale) {
    const langMatch = byLocale.get(lang)?.[key];
    if (langMatch !== undefined) return langMatch;
  }

  // 3. English fallback
  return byLocale.get('en')?.[key];
}

// ─── Public API factory ──────────────────────────────────────

/**
 * Build the i18n API object exposed as `api.i18n` inside each plugin.
 *
 * @example
 * // In your plugin activate():
 * api.i18n.addTranslations('en', { 'banner.title': 'Hello' });
 * api.i18n.addTranslations('de', { 'banner.title': 'Hallo' });
 *
 * // Later, in any React component the plugin renders:
 * const title = api.i18n.t('banner.title');
 * const greeting = api.i18n.t('welcome', { name: 'Alice' }); // 'Hello, {name}!'
 */
export function createPluginI18n(pluginId: string) {
  return {
    /**
     * Register translations for one locale.
     * Multiple calls for the same locale are merged (last-write-wins on key collision).
     *
     * @param locale  BCP-47 locale tag, e.g. "en", "de", "fr-CA"
     * @param strings Key → translated string map.  Use {paramName} for interpolation.
     */
    addTranslations(locale: string, strings: Record<string, string>): void {
      let byLocale = registry.get(pluginId);
      if (!byLocale) {
        byLocale = new Map<string, Record<string, string>>();
        registry.set(pluginId, byLocale);
      }
      const existing = byLocale.get(locale) ?? {};
      byLocale.set(locale, { ...existing, ...strings });
    },

    /**
     * Translate a key using the current app locale.
     * Falls back through: exact locale → language prefix → 'en' → raw key.
     *
     * @param key    Translation key, e.g. `'banner.title'`
     * @param params Optional interpolation values, e.g. `{ count: 3 }`
     */
    t(key: string, params?: Record<string, string | number>): string {
      const template = resolve(pluginId, key);
      if (template !== undefined) return interpolate(template, params);
      return key; // never throw - just return the key
    },

    /** The current app locale (e.g. "en", "de", "fr") */
    getLocale(): string {
      return currentLocale;
    },
  };
}

export type PluginI18nInstance = ReturnType<typeof createPluginI18n>;
