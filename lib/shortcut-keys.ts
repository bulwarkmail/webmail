// One notation for key combinations in the help modal and in hints: "Mod"
// (and the older "Ctrl/⌘", "Ctrl/Cmd" forms) is ⌘ on Apple devices and Ctrl
// everywhere else; Alt is ⌥ on Apple devices. Entries are written with
// "Mod + K", "Shift + Mod + Enter", alternatives separated by " / ".

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const MOD = /^(mod|ctrl\/⌘|ctrl\/cmd|cmd\/ctrl|⌘\/ctrl)$/i;

/**
 * Key names as Windows writes them in each language, on its keyboards and in every app's
 * menus: German "Strg+Umschalt+R", "Entf". Languages not here keep the English names, as
 * Windows does for them. macOS has symbols, which need no words.
 */
const KEY_NAMES: Record<string, Record<string, string>> = {
  de: { Ctrl: 'Strg', Shift: 'Umschalt', Del: 'Entf', Delete: 'Entf', Enter: 'Eingabe', Backspace: 'Rücktaste', Home: 'Pos1', End: 'Ende', PageUp: 'Bild↑', PageDown: 'Bild↓', Insert: 'Einfg', Space: 'Leertaste' },
  fr: { Shift: 'Maj', Del: 'Suppr', Delete: 'Suppr', Enter: 'Entrée', Backspace: 'Retour arrière', Home: 'Origine', End: 'Fin', PageUp: 'Pg.Préc', PageDown: 'Pg.Suiv', Insert: 'Inser', Space: 'Espace' },
  es: { Shift: 'Mayús', Del: 'Supr', Delete: 'Supr', Enter: 'Entrar', Backspace: 'Retroceso', Home: 'Inicio', End: 'Fin', PageUp: 'Re Pág', PageDown: 'Av Pág', Space: 'Espacio' },
  it: { Shift: 'Maiusc', Del: 'Canc', Delete: 'Canc', Enter: 'Invio', Space: 'Spazio' },
};

/** The app's language, from <html lang> (components/providers/intl-provider.tsx keeps it). */
function pageLanguage(): string {
  if (typeof document === 'undefined') return 'en';
  return (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
}

/**
 * One key's name in a language: "Ctrl" is "Strg" in German. Takes the English names this
 * notation and Electron use ("Ctrl", "Shift", "Del", "Delete", "Enter", "PageUp"); anything
 * else comes back as it is. `language` defaults to the app's.
 */
export function localKeyName(name: string, language: string = pageLanguage()): string {
  const table = KEY_NAMES[language.toLowerCase().split('-')[0]];
  if (!table) return name;
  const canonical = Object.keys(table).find((key) => key.toLowerCase() === name.toLowerCase());
  return canonical ? table[canonical] : name;
}

/** One key or combination ("Mod + Enter") in the notation of this platform and the app's language. */
export function formatShortcutCombo(combo: string, apple = isApplePlatform(), language: string = pageLanguage()): string {
  // Keeps the spacing it was written with ("Ctrl+Shift+Y" from a plugin).
  const separator = /\s\+\s/.test(combo) ? " + " : "+";
  return combo
    .split(/\s*\+\s*/)
    .map((part) => {
      if (MOD.test(part)) return apple ? '⌘' : localKeyName('Ctrl', language);
      if (/^ctrl$/i.test(part)) return apple ? '⌘' : localKeyName('Ctrl', language);
      if (/^(cmd|⌘)$/i.test(part)) return apple ? '⌘' : localKeyName('Ctrl', language);
      if (/^alt$/i.test(part)) return apple ? '⌥' : 'Alt';
      return apple ? part : localKeyName(part, language);
    })
    .join(separator);
}

/** The alternatives of a shortcut ("j / ↓"), each in the notation of this platform and the app's language. */
export function shortcutAlternatives(key: string, apple = isApplePlatform(), language: string = pageLanguage()): string[] {
  return key.split(' / ').map((combo) => formatShortcutCombo(combo, apple, language));
}
