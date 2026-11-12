/**
 * Unicode directional formatting characters: the explicit embeddings,
 * overrides and isolates (U+202A-202E, U+2066-2069) and the LRM/RLM marks.
 * In a sender-controlled name they reorder what the reader sees, so
 * `report‮fdp.exe` shows as `reportexe.pdf`.
 */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

/** `text` without directional formatting characters, for display. */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}

// Letters of the right-to-left scripts: Hebrew to NKo and the scripts after
// it, the presentation forms, and the RTL blocks of the supplementary planes.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
const LETTER = /\p{L}/u;

/** The direction of `text`'s first letter, or null when it has none. */
export function firstStrongDirection(text: string): 'ltr' | 'rtl' | null {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return 'rtl';
    if (LETTER.test(ch)) return 'ltr';
  }
  return null;
}
