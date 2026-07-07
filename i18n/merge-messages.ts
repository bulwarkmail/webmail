type Messages = Record<string, unknown>;

/**
 * Deep-merge `override` onto `base`, returning a new object. Keys present only
 * in `base` survive — used to fall back to English for any string a locale has
 * not translated yet, so the UI shows the English text rather than a raw
 * message key (e.g. "settings.tabs.layout").
 */
export function mergeMessages(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const key of Object.keys(override)) {
    const b = out[key];
    const o = override[key];
    if (b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o)) {
      out[key] = mergeMessages(b as Messages, o as Messages);
    } else {
      out[key] = o;
    }
  }
  return out;
}
