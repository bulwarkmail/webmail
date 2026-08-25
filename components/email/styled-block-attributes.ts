// Pasted email content (signatures, replies, quoted text) commonly carries
// inline styles on block elements. StarterKit's default Paragraph/Heading
// drop unknown attributes; the composer extends them with these so `style`,
// `class` and the signature range marker round-trip the editor. Kept in its
// own module so tests can build the exact composer paragraph instead of
// hand-copying (and silently drifting from) this config.
export const styledBlockAttributes = {
  style: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute("style"),
    renderHTML: (attrs: Record<string, string | null>) =>
      attrs.style ? { style: attrs.style } : {},
  },
  class: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute("class"),
    renderHTML: (attrs: Record<string, string | null>) =>
      attrs.class ? { class: attrs.class } : {},
  },
  "data-signature-block": {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-signature-block"),
    renderHTML: (attrs: Record<string, string | null>) =>
      attrs["data-signature-block"]
        ? { "data-signature-block": attrs["data-signature-block"] }
        : {},
  },
};
