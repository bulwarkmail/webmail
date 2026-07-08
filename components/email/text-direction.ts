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
 * paragraphs/headings as LTR or RTL (Gmail-style right-to-left editing). The
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
            default: null,
            parseHTML: (element) => element.getAttribute("dir") || null,
            renderHTML: (attributes) =>
              attributes.dir ? { dir: attributes.dir } : {},
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
