import { Extension } from "@tiptap/core";

export type TextDir = "ltr" | "rtl";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textDirection: {
      setTextDirection: (dir: TextDir) => ReturnType;
      unsetTextDirection: () => ReturnType;
    };
  }
}

/**
 * Adds a `dir` attribute to block nodes so the composer can mark individual
 * paragraphs/headings as LTR or RTL (Gmail-style right-to-left editing).
 *
 * The default is `"auto"`: each block detects its own direction from its first
 * strong character, so a paragraph typed in English renders LTR and one typed
 * in Hebrew renders RTL, per block, as you type. The toolbar toggle still pins
 * an explicit `ltr`/`rtl` when you want to override the auto-detection, and the
 * attribute round-trips to HTML so the direction is preserved in the sent mail.
 */
export const TextDirection = Extension.create({
  name: "textDirection",

  addOptions() {
    return { types: ["paragraph", "heading", "blockquote", "listItem"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          dir: {
            default: "auto",
            parseHTML: (element) => element.getAttribute("dir") || "auto",
            renderHTML: (attributes) =>
              attributes.dir ? { dir: attributes.dir } : { dir: "auto" },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextDirection:
        (dir) =>
        ({ commands }) =>
          this.options.types.every((type: string) =>
            commands.updateAttributes(type, { dir }),
          ),
      unsetTextDirection:
        () =>
        ({ commands }) =>
          this.options.types.every((type: string) =>
            commands.resetAttributes(type, "dir"),
          ),
    };
  },
});
