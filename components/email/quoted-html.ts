"use client";

import { Node as TiptapNode, mergeAttributes } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

import { buildSignatureBlock } from "@/components/email/signature-block";

// Marker attribute that identifies the quoted-original wrapper in serialized
// HTML, so parseHTML can recognise it on the way back in.
export const QUOTED_HTML_MARKER = "data-quoted-html";

// Reusable style for the quote bar when quoting email text (like in a reply).
const QUOTE_BAR_STYLE =
  "border-left:2px solid #c5c5c5;padding-left:12px;margin-top:8px;";

/**
 * QuotedHtml — an atomic block node that carries the *verbatim* HTML of a
 * quoted/forwarded original email. The HTML is stored in the `html` attribute
 * and is NEVER parsed into the ProseMirror schema, so layout-heavy emails
 * (nested tables, MJML, Outlook divs) survive a reply/forward 1:1.
 *
 * Behaviour:
 *  - To ProseMirror it's a single atomic block: Backspace at the boundary or
 *    Ctrl+A + Delete removes the whole quote in one go ("wie es sich gehört").
 *  - Its NodeView renders an inner `contentEditable` region so the user can
 *    still redact text inside the quote. Inner edits are synced back into the
 *    `html` attribute (without polluting the undo history).
 *
 * Serialization: ProseMirror's DOM serializer can't emit an atom's inner raw
 * HTML, so use `serializeEditorContent(editor)` (below) instead of
 * `editor.getHTML()` to read the composer body for sending/draft-saving.
 */
export const QuotedHtml = TiptapNode.create({
  name: "quotedHtml",
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
        // Capture the verbatim inner HTML when parsing. Because the node is
        // an atom, ProseMirror does NOT descend into the children, so they
        // never hit the schema.
        parseHTML: (el) => el.innerHTML,
        // Not rendered as an attribute - the real content round-trips via the
        // custom serializer. renderHTML below only needs the wrapper.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${QUOTED_HTML_MARKER}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    // Only used for ProseMirror's internal/clipboard round-trip. The send /
    // draft path uses serializeEditorContent() which inlines attrs.html.
    return ["div", mergeAttributes(HTMLAttributes, { [QUOTED_HTML_MARKER]: "" })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      // Host element ProseMirror manages. A subtle left border echoes the
      // classic email quote bar without touching the quoted content's styling.
      const dom = document.createElement("div");
      dom.setAttribute(QUOTED_HTML_MARKER, "");
      dom.className = "quoted-html-island";
      dom.style.cssText = QUOTE_BAR_STYLE;

      // CRITICAL: render the quoted email inside a Shadow Root. The app's
      // global CSS (Tailwind preflight, .tiptap table/td rules, box-sizing
      // resets) would otherwise cascade INTO the quote and destroy its layout
      // - even though the verbatim HTML serializes/sends perfectly. Shadow DOM
      // isolates both directions: only the browser's UA defaults + the email's
      // own inline styles apply, so the in-editor rendering matches the sent
      // mail 1:1.
      const shadow = dom.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      inner.contentEditable = "true";
      inner.style.cssText = "outline:none;";
      inner.innerHTML = node.attrs.html || "";
      shadow.appendChild(inner);

      // Track focus via focusin/focusout: inside a shadow root,
      // document.activeElement is retargeted to the host, so we can't rely on
      // it to detect "is the user editing in here".
      let focused = false;
      inner.addEventListener("focusin", () => {
        focused = true;
      });
      inner.addEventListener("focusout", () => {
        focused = false;
      });

      // Sync inner edits back into the node attribute. Coalesced via rAF so a
      // burst of keystrokes is one transaction; addToHistory:false keeps
      // redaction edits out of the editor's undo stack. The `input` event is
      // composed and crosses the shadow boundary, so this listener fires.
      let frame = 0;
      const syncBack = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (typeof getPos !== "function") return;
          const pos = getPos();
          if (pos == null) return;
          const current = inner.innerHTML;
          if (current === node.attrs.html) return;
          editor.view.dispatch(
            editor.view.state.tr
              .setNodeAttribute(pos, "html", current)
              .setMeta("addToHistory", false)
          );
        });
      };
      inner.addEventListener("input", syncBack);

      return {
        dom,
        // ProseMirror must not try to reconcile the foreign shadow content.
        ignoreMutation: () => true,
        // Events originating inside the island are retargeted to the host
        // (`dom`) once they cross the shadow boundary, so dom.contains(target)
        // is true for them → let the native shadow contentEditable handle
        // them. Events from the surrounding doc (boundary Backspace,
        // Ctrl+A+Delete) target other elements → fall through to ProseMirror
        // so whole-block deletion still works.
        stopEvent: (event) => {
          const target = event.target as Node | null;
          return !!target && dom.contains(target);
        },
        update: (updatedNode) => {
          if (updatedNode.type.name !== "quotedHtml") return false;
          // Don't clobber the caret while the user is redacting inside.
          if (!focused && inner.innerHTML !== updatedNode.attrs.html) {
            inner.innerHTML = updatedNode.attrs.html || "";
          }
          return true;
        },
        destroy: () => {
          cancelAnimationFrame(frame);
          inner.removeEventListener("input", syncBack);
        },
      };
    };
  },
});

/**
 * Serialize the composer document to HTML for sending / draft-saving.
 *
 * Use this INSTEAD of `editor.getHTML()`: ProseMirror's DOM serializer cannot
 * emit the raw inner HTML of an atom node, so it would drop the quoted body.
 * Here we walk the top-level nodes, inline the quote node's verbatim `html`,
 * and serialize everything else normally.
 */
export function serializeEditorContent(editor: Editor): string {
  const serializer = DOMSerializer.fromSchema(editor.schema);
  const parts: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === "quotedHtml") {
      // Emit the SAME wrapper buildQuotedHtmlBlock produces, so a saved draft
      // round-trips: re-opening parses this back into a QuotedHtml node
      // instead of letting the schema mangle the raw table layout again.
      parts.push(buildQuotedHtmlBlock((node.attrs.html as string) || ""));
      return;
    }
    if (node.type.name === "signatureBlock") {
      // Same rationale as quotedHtml: inline the verbatim signature HTML so the
      // styled signature reaches the recipient (and a saved draft round-trips)
      // instead of the schema-flattened version.
      parts.push(buildSignatureBlock((node.attrs.html as string) || ""));
      return;
    }
    const fragment = serializer.serializeNode(node);
    const tmp = document.createElement("div");
    tmp.appendChild(fragment);
    parts.push(tmp.innerHTML);
  });
  return parts.join("");
}

/**
 * Build the editor-content wrapper that the composer prepends/appends so the
 * quoted original becomes a single QuotedHtml node. The inner HTML must be
 * pre-sanitized (scripts/styles/head stripped, cid: images rewritten).
 *
 * The `data-quoted-html` marker is what parseHTML keys on, so this exact form
 * must be what serializeEditorContent emits too (round-trip consistency).
 */
export function buildQuotedHtmlBlock(sanitizedInnerHtml: string): string {
  return `<div ${QUOTED_HTML_MARKER} style="${QUOTE_BAR_STYLE}">${sanitizedInnerHtml}</div>`;
}
