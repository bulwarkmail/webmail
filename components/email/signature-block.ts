"use client";

import { Node as TiptapNode, mergeAttributes } from "@tiptap/core";

// Marker attribute that identifies the signature wrapper in serialized HTML,
// so parseHTML can recognise it on the way back in (initial content, drafts).
export const SIGNATURE_BLOCK_MARKER = "data-signature-block-node";

/**
 * Force every link in the rendered signature to open in a new tab.
 *
 * Applied to the NodeView's DOM only, never to `attrs.html` — that attribute is
 * what serializeEditorContent emits into the sent message, and the recipient's
 * copy should stay exactly as the user wrote it. Without this the composer's
 * signature is a set of live, target-less anchors in the main document (the
 * message body gets a sandboxed iframe; this does not), so one stray click
 * navigates the whole app away and takes the unsent draft with it.
 */
function forceLinksToNewTab(root: HTMLElement): void {
  root.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * SignatureBlock — an atomic, NON-editable block node that carries the
 * *verbatim* HTML of the user's identity signature in its `html` attribute.
 *
 * Why: the signature is embedded into the composer so it stays in the body,
 * but parsing rich, table-based "brand" signatures into the ProseMirror schema
 * strips their inline CSS (background/text colors, fonts, border-radius). By
 * holding the signature as an atom it is never parsed into the schema, so the
 * styling survives 1:1 — both in the editor (rendered by the NodeView below)
 * and in the sent mail (emitted by serializeEditorContent in quoted-html.ts).
 *
 * Mirrors QuotedHtml, but the inner region is read-only: a signature is meant
 * to be inserted/removed as a unit, not edited inline. Select the node and
 * press Backspace/Delete to drop the whole signature.
 */
export const SignatureBlock = TiptapNode.create({
  name: "signatureBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  // Isolating keeps selection/gapcursor behaviour sane at the boundary.
  isolating: true,

  addAttributes() {
    return {
      html: {
        default: "",
        // Capture the verbatim inner HTML when parsing. Because the node is an
        // atom, ProseMirror does NOT descend into the children, so the rich
        // signature markup never hits (and is never mangled by) the schema.
        parseHTML: (el) => el.innerHTML,
        // The real content round-trips via the custom serializer
        // (serializeEditorContent); renderHTML below only needs the wrapper.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${SIGNATURE_BLOCK_MARKER}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    // Only used for ProseMirror's internal/clipboard round-trip. The send /
    // draft path uses serializeEditorContent() which inlines attrs.html.
    return ["div", mergeAttributes(HTMLAttributes, { [SIGNATURE_BLOCK_MARKER]: "" })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.setAttribute(SIGNATURE_BLOCK_MARKER, "");
      dom.className = "signature-block-island";


      // CRITICAL: render the signature inside a Shadow Root. The app's global
      // CSS (Tailwind preflight, .tiptap table/td rules, box-sizing resets)
      // would otherwise cascade INTO the signature and destroy its layout -
      // exactly the corruption we are fixing. Shadow DOM isolates both
      // directions, so only the browser's UA defaults + the signature's own
      // inline styles apply and the in-editor preview matches the sent mail.
      const shadow = dom.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      // Read-only: a signature is inserted/removed as a unit, not edited inline.
      inner.contentEditable = "false";
      // Track what we were given, not what's in the DOM: forceLinksToNewTab
      // rewrites the markup, so inner.innerHTML no longer round-trips against
      // attrs.html and comparing the two would rewrite on every transaction.
      let appliedHtml = node.attrs.html || "";
      inner.innerHTML = appliedHtml;
      forceLinksToNewTab(inner);
      shadow.appendChild(inner);

      return {
        dom,
        // ProseMirror must not try to reconcile the foreign shadow content.
        ignoreMutation: () => true,
        // Let ProseMirror handle all events so clicking selects the atom and
        // Backspace/Delete removes the whole signature.
        stopEvent: () => false,
        update: (updatedNode) => {
          if (updatedNode.type.name !== "signatureBlock") return false;
          const nextHtml = updatedNode.attrs.html || "";
          if (nextHtml !== appliedHtml) {
            appliedHtml = nextHtml;
            inner.innerHTML = nextHtml;
            forceLinksToNewTab(inner);
          }
          return true;
        },
      };
    };
  },
});

/**
 * Build the editor-content wrapper that embeds the signature as a single
 * SignatureBlock node. The inner HTML must be pre-sanitized
 * (sanitizeSignatureHtml). The `data-signature-block-node` marker is what
 * parseHTML keys on, so this exact form must be what serializeEditorContent
 * emits too (round-trip consistency).
 */
export function buildSignatureBlock(sanitizedInnerHtml: string): string {
  return `<div ${SIGNATURE_BLOCK_MARKER}>${sanitizedInnerHtml}</div>`;
}
