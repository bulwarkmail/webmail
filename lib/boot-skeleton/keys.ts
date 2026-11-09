/** localStorage key for the hints the app leaves for the next boot (rail apps). */
export const BOOT_HINTS_KEY = 'bulwark-boot-hints';
/** localStorage key for the last applied theme CSS, replayed before the first paint. */
export const THEME_CACHE_KEY = 'bulwark-theme-cache';
/** Theme CSS above this many characters is not cached (localStorage is small and shared). */
export const THEME_CACHE_MAX = 200_000;
