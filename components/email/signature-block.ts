"use client";

import { Node as TiptapNode, mergeAttributes, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { parseHtmlSafely } from "@/lib/email-sanitization";

// Marker attribute that identifies the signature wrapper in serialized HTML,
// so parseHTML can recognise it on the way back in (initial content, drafts).
export const SIGNATURE_BLOCK_MARKER = "data-signature-block-node";

// Marker attribute on the paragraphs that bracket an embedded signature
// (`data-signature-block="separator" | "start" | "end"`). The composer keys the
// identity-swap splice on it, and it is what tells a re-opened draft that its
// body already carries the signature.
export const SIGNATURE_RANGE_MARKER = "data-signature-block";

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
 *
 * Read-only is the default, not a wall (#822): double-click the block to
 * dissolve it into regular editable content via
 * {@link unlockSignatureBlock}. That trades the verbatim-styling guarantee
 * for editability - the explicit user gesture is what makes the trade
 * acceptable, unlike the silent flattening #476 fixed. (Enter on the selected
 * block deliberately keeps ProseMirror's default create-paragraph-after
 * behaviour - it is a low-intent everyday key.)
 */
export const SignatureBlock = TiptapNode.create({
  name: "signatureBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  // Isolating keeps selection/gapcursor behaviour sane at the boundary.
  isolating: true,

  addOptions() {
    return {
      // Translated tooltip shown on the block ("Double-click to edit the
      // signature"). Set via .configure() where translations are available;
      // empty means no tooltip.
      editHint: "",
    };
  },

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
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.setAttribute(SIGNATURE_BLOCK_MARKER, "");
      dom.className = "signature-block-island";
      if (this.options.editHint) {
        dom.title = this.options.editHint;
      }
      // Double-click dissolves the atom into regular editable content (#822).
      // The listener sits on the wrapper; shadow-root events are composed, so
      // it fires for the whole island.
      dom.addEventListener("dblclick", (event) => {
        // A double-click landing on a link is the user working the link (the
        // first click already opened it) - not a request to start editing.
        if (event.composedPath().some((t) => (t as Element).tagName === "A")) return;
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos == null) return;
        // Only claim the event when the unlock actually ran - in a read-only
        // editor the default dblclick behaviour must stay untouched.
        if (unlockSignatureBlock(editor, pos)) event.preventDefault();
      });


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

// Block elements that must not end up inside a <p>: a div containing any of
// these is a container, not a text line, and is left for the schema parse.
const NON_LINE_BLOCKS =
  "div, p, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, hr, pre, address, figure, dl";

// Inherited style properties hoisted from wrapper divs onto the generated
// line paragraphs. Wrappers themselves have no schema node and are dropped by
// the parse, so without hoisting the font/color the whole signature inherits
// from its container would silently vanish on unlock. Longhands only: setting
// the `font` shorthand would reset font longhands the line declares itself
// (browsers expose shorthand values through the longhands anyway).
// Non-inherited properties (background, border, padding) are deliberately NOT
// hoisted - per-line copies would render differently than the container did.
const INHERITED_STYLE_PROPS = [
  "font-family", "font-size", "font-style", "font-weight",
  "color", "line-height", "letter-spacing", "text-transform", "direction",
];

/**
 * Line-level <div>s render margin-less in mail clients, but the editor schema
 * has no div node: parsing would re-wrap their content into default-margin
 * paragraphs and the signature's tight line structure blows apart into spaced
 * paragraphs. Rewrite leaf divs into explicit margin-0 paragraphs (keeping
 * their attributes, inheriting wrapper styles) so the unlocked signature
 * keeps the locked rendering's line spacing - the composer's paragraph
 * preserves inline styles. Vertical margins are reset only where the line
 * does not set them itself; horizontal margins (indented lines) are left
 * alone. <br> runs and <p> blocks are untouched (the schema already handles
 * those faithfully). Returns the parsed body element, ready for the
 * ProseMirror DOM parser.
 */
function normalizeSignatureHtmlForEditing(html: string): HTMLElement {
  const doc = parseHtmlSafely(html);
  const body = doc.body;
  body.querySelectorAll("div").forEach((div) => {
    if (div.querySelector(NON_LINE_BLOCKS)) return;
    const p = doc.createElement("p");
    for (const attr of Array.from(div.attributes)) p.setAttribute(attr.name, attr.value);
    // Hoist inherited styles from wrapper divs, outermost first so closer
    // wrappers win; the line's own declarations always take precedence.
    const wrappers: HTMLElement[] = [];
    for (let ancestor = div.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DIV") wrappers.unshift(ancestor);
    }
    for (const wrapper of wrappers) {
      for (const prop of INHERITED_STYLE_PROPS) {
        const value = wrapper.style.getPropertyValue(prop);
        if (value && !div.style.getPropertyValue(prop)) p.style.setProperty(prop, value);
      }
    }
    // A div renders with zero margins; reset only the verticals the line
    // does not declare itself, keeping explicit spacing and indents intact.
    if (!p.style.margin) {
      if (!p.style.marginTop) p.style.marginTop = "0";
      if (!p.style.marginBottom) p.style.marginBottom = "0";
    }
    while (div.firstChild) p.appendChild(div.firstChild);
    div.replaceWith(p);
  });
  // An empty signature still needs a block to put the caret into.
  if (!body.firstElementChild) body.appendChild(doc.createElement("p"));
  return body;
}

/**
 * Dissolve the signature atom at `pos` into regular, editable editor content
 * (#822). The verbatim HTML is parsed into the schema at the atom's position -
 * the pre-#476 representation, with the known consequence that heavily styled
 * markup may be normalized by the schema. Leaf <div> lines are rewritten to
 * margin-0 paragraphs first so the line spacing survives the parse (see
 * normalizeSignatureHtmlForEditing). The bracketing `data-signature-block`
 * marker paragraphs live OUTSIDE the atom and are left untouched, so the
 * identity-switch splice and the send path's already-embedded detection keep
 * working on the unlocked content, and switching identities re-embeds a fresh
 * locked block. Undo restores the atom.
 */
export function unlockSignatureBlock(editor: Editor, pos: number): boolean {
  if (!editor.isEditable) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "signatureBlock") return false;
  const body = normalizeSignatureHtmlForEditing(String(node.attrs.html || ""));
  // Parse as a CLOSED document (complete blocks) and splice it in with one
  // plain transaction. insertContentAt parses an OPEN slice instead, and
  // fitting an open slice may split text runs at hard breaks - which turned a
  // <br>-lined signature into one spaced paragraph per line in the browser.
  // A closed fragment of complete blocks cannot be refitted that way.
  const parsed = ProseMirrorDOMParser.fromSchema(editor.state.schema).parse(body, {
    preserveWhitespace: false,
  });
  const tr = editor.state.tr.replaceWith(pos, pos + node.nodeSize, parsed.content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos))).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

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

/**
 * Whether an HTML body already carries an embedded signature. Both markers are
 * checked via the shared prefix: `SIGNATURE_BLOCK_MARKER` starts with
 * `SIGNATURE_RANGE_MARKER`, so a bracketed signature and a bare signature atom
 * (e.g. a body whose marker paragraphs were dropped) both match.
 *
 * A re-opened draft always comes back in `compose` mode, so the markers are the
 * only evidence the send path has that the signature is already in the body and
 * must not be appended a second time (#823).
 */
export function containsEmbeddedSignature(html: string): boolean {
  return html.includes(SIGNATURE_RANGE_MARKER);
}
