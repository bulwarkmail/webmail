/**
 * Tiptap extension for text direction (LTR / RTL).
 *
 * Adds a `dir` attribute to heading and paragraph nodes and provides
 * `setTextDirection` and `toggleTextDirection` chain commands so the
 * toolbar button can switch directions per block.
 */
import { Extension } from "@tiptap/core";

export type TextDirectionValue = "ltr" | "rtl" | null;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textDirection: {
      /** Set explicit direction on the current block(s). */
      setTextDirection: (direction: TextDirectionValue) => ReturnType;
      /** Toggle between "rtl" and "ltr" on the current block(s). */
      toggleTextDirection: () => ReturnType;
    };
  }
}

/**
 * Unicode ranges used for auto-detection of the first strong character.
 * Ranges cover Arabic, Hebrew, Syriac, Thaana, N'Ko, Samaritan, Mandaic,
 * and supplemental Arabic blocks — essentially every RTL script in active use.
 */
const RTL_RANGES = [
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic
  [0xfb1d, 0xfdff], // Hebrew presentation forms, Arabic presentation forms-A
  [0xfe70, 0xfefc], // Arabic presentation forms-B
  [0x10800, 0x10fff], // Cypriot, Imperial Aramaic, Palmyrene, etc.
  [0x1e800, 0x1edff], // Mende Kikakui, Adlam
  [0x1ee00, 0x1eeff], // Arabic mathematical alphabetic symbols
];

function isRtlChar(codePoint: number): boolean {
  return RTL_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/**
 * Detect the natural direction of text by scanning for the first strong
 * character. Returns "rtl" if the first strong character is RTL, "ltr"
 * otherwise.
 */
export function detectTextDirection(text: string): "ltr" | "rtl" {
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (isRtlChar(cp)) return "rtl";
    // Any Latin, Cyrillic, Greek, or other LTR letter is a strong LTR signal
    if (
      (cp >= 0x0041 && cp <= 0x005a) || // A-Z
      (cp >= 0x0061 && cp <= 0x007a) || // a-z
      (cp >= 0x0400 && cp <= 0x04ff) || // Cyrillic
      (cp >= 0x0370 && cp <= 0x03ff) || // Greek
      (cp >= 0x0900 && cp <= 0x097f) || // Devanagari
      (cp >= 0x4e00 && cp <= 0x9fff)    // CJK
    ) {
      return "ltr";
    }
  }
  return "ltr";
}

export const TextDirection = Extension.create({
  name: "textDirection",

  addGlobalAttributes() {
    return [
      {
        types: ["heading", "paragraph"],
        attributes: {
          dir: {
            default: null as string | null,
            parseHTML: (element: HTMLElement) => {
              const dir = element.getAttribute("dir");
              if (dir === "rtl") return "rtl";
              if (dir === "ltr") return "ltr";
              return null;
            },
            renderHTML: (attributes: Record<string, string | null>) => {
              if (attributes.dir === "rtl") return { dir: "rtl" };
              if (attributes.dir === "ltr") return { dir: "ltr" };
              return {};
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextDirection:
        (direction: TextDirectionValue) =>
        ({ commands }) => {
          if (direction === null) {
            // Unset direction on current blocks
            return commands.updateAttributes("heading", { dir: null }) &&
                   commands.updateAttributes("paragraph", { dir: null });
          }
          return commands.updateAttributes("heading", { dir: direction }) &&
                 commands.updateAttributes("paragraph", { dir: direction });
        },
      toggleTextDirection:
        () =>
        ({ editor, commands }) => {
          const currentDir = editor.getAttributes("paragraph").dir ||
                             editor.getAttributes("heading").dir;
          const next: TextDirectionValue = currentDir === "rtl" ? "ltr" : "rtl";
          return commands.setTextDirection(next);
        },
    };
  },
});
