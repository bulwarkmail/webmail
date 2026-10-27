"use client";

import { Node as TiptapNode, mergeAttributes } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

import { addParagraphSpacing, addTrailingParagraphBreaks } from "@/components/email/paragraph-breaks";
import { buildSignatureBlock } from "@/components/email/signature-block";
import { parkRemoteResources, restoreRemoteResources, sanitizeComposerIslandHtml } from "@/lib/email-sanitization";
import { useSettingsStore } from "@/stores/settings-store";

// Marker attribute that identifies the quoted-original wrapper in serialized
// HTML, so parseHTML can recognise it on the way back in.
export const QUOTED_HTML_MARKER = "data-quoted-html";

// Set on the wrapper the composer builds when the quoted message may load
// remote content (policy "allow", or a trusted sender). Display hint only:
// serializeEditorContent never emits it.
const QUOTED_REMOTE_ALLOWED_ATTR = "data-quoted-remote";

// Atom blocks typing must never replace just because they were left selected.
const ATOM_BLOCKS = new Set(["quotedHtml", "signatureBlock"]);

// Reusable style for the quote bar when quoting email text (like in a reply).
const QUOTE_BAR_STYLE =
  "border-left:2px solid #c5c5c5;padding-left:12px;margin-top:8px;";

// Editor-only, never serialized into the sent mail: the quoted original is a
// sender's HTML rendered in the app document (the shadow root isolates its
// styles, not its layout), so a `position:fixed` element in it would cover
// the composer and the app with whatever the sender drew. `contain:paint`
// with a positioned, clipping box confines painting to the quote's own box.
const QUOTE_ISLAND_CONTAINMENT_STYLE = "position:relative;overflow:hidden;contain:paint;";

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
      showQuoteBorder: {
        default: true,
        parseHTML: (el) => el.getAttribute("data-quote-border") !== "false",
        renderHTML: (attrs) => attrs.showQuoteBorder === false ? { "data-quote-border": "false" } : {},
      },
      html: {
        default: "",
        // Capture the verbatim inner HTML when parsing. Because the node is
        // an atom, ProseMirror does NOT descend into the children, so they
        // never hit the schema - nor its attribute allowlist, so sanitize
        // here: a re-opened draft hands this wrapper in unsanitized.
        parseHTML: (el) => sanitizeComposerIslandHtml(el.innerHTML),
        // Not rendered as an attribute - the real content round-trips via the
        // custom serializer. renderHTML below only needs the wrapper.
        renderHTML: () => ({}),
      },
      remoteAllowed: {
        default: false,
        parseHTML: (el) => el.getAttribute(QUOTED_REMOTE_ALLOWED_ATTR) === "allowed",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${QUOTED_HTML_MARKER}]` }];
  },

  addProseMirrorPlugins() {
    // Set once the user put the caret somewhere (click, tap) or the editor
    // already had focus, so later focus keeps that position.
    let placedByUser = false;
    const markPlaced = () => {
      placedByUser = true;
      return false;
    };
    return [
      new Plugin({
        key: new PluginKey("quotedHtmlFocus"),
        props: {
          handleDOMEvents: {
            mousedown: markPlaced,
            touchstart: markPlaced,
            // Where the editor's selection rests before the user touched it
            // is an accident of how the body was built: on the quote (or
            // signature) as a node in a reply, where the first key typed
            // replaced the whole block, or after the signature in a new
            // message. Focus from the keyboard puts the caret at the start
            // instead; a click still lands where it was aimed, because
            // ProseMirror handles the click after the focus event.
            focus: (view) => {
              const { selection, doc } = view.state;
              const onAtom = selection instanceof NodeSelection
                && ATOM_BLOCKS.has(selection.node.type.name);
              if (onAtom || !placedByUser) {
                const start = Selection.atStart(doc);
                if (start instanceof TextSelection && !start.eq(selection)) {
                  view.dispatch(view.state.tr.setSelection(start));
                }
              }
              placedByUser = true;
              return false;
            },
          },
        },
      }),
    ];
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
      const updateQuoteStyle = (showBorder: boolean) => {
        dom.style.cssText = (showBorder ? QUOTE_BAR_STYLE : "margin-top:8px;")
          + QUOTE_ISLAND_CONTAINMENT_STYLE;
      };
      updateQuoteStyle(node.attrs.showQuoteBorder !== false);

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

      // The quote renders in the app document, where the viewer's iframe
      // CSP does not reach: unless the quoted message may load remote
      // content, its images and backgrounds are parked so opening a reply
      // doesn't fire the trackers the viewer held back. Parking is
      // display-only - the html attribute (what gets sent) keeps them.
      const blockRemote =
        !node.attrs.remoteAllowed && useSettingsStore.getState().externalContentPolicy !== "allow";
      let renderedHtml = "";
      const render = (html: string) => {
        renderedHtml = html;
        inner.innerHTML = blockRemote ? parkRemoteResources(html).html : html;
      };
      const readBack = () => (blockRemote ? restoreRemoteResources(inner.innerHTML) : inner.innerHTML);
      render(node.attrs.html || "");
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
          const current = readBack();
          if (current === node.attrs.html) return;
          renderedHtml = current;
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
          updateQuoteStyle(updatedNode.attrs.showQuoteBorder !== false);
          // Don't clobber the caret while the user is redacting inside.
          if (!focused && (updatedNode.attrs.html || "") !== renderedHtml) {
            render(updatedNode.attrs.html || "");
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
  // Empty paragraphs at the very end (the editor keeps one after a quote)
  // stay invisible; every other empty line gets a <br> so it keeps its
  // height in the recipient's client (#1015).
  let lastLine = -1;
  editor.state.doc.forEach((node, _offset, index) => {
    if (node.type.name !== "paragraph" || node.childCount > 0) lastLine = index;
  });
  editor.state.doc.forEach((node, _offset, index) => {
    if (node.type.name === "quotedHtml") {
      // Emit the SAME wrapper buildQuotedHtmlBlock produces, so a saved draft
      // round-trips: re-opening parses this back into a QuotedHtml node
      // instead of letting the schema mangle the raw table layout again.
      parts.push(buildQuotedHtmlBlock((node.attrs.html as string) || "", { showQuoteBorder: node.attrs.showQuoteBorder !== false }));
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
    if (index <= lastLine) addTrailingParagraphBreaks(tmp);
    addParagraphSpacing(tmp);
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
export function buildQuotedHtmlBlock(
  sanitizedInnerHtml: string,
  opts: { remoteAllowed?: boolean; showQuoteBorder?: boolean } = {},
): string {
  const showQuoteBorder = opts.showQuoteBorder !== false;
  let html = sanitizedInnerHtml;
  if (!showQuoteBorder) {
    // Outlook-style replies flatten quote levels, including earlier replies.
    // Work on sanitized DOM so tables, links and signatures remain intact.
    // A template's content is inert: parsed into a plain div, the original's
    // remote images would load here, past the parking the island does.
    const container = document.createElement("template");
    container.innerHTML = html;
    const content = container.content;
    content.querySelectorAll("blockquote").forEach((quote) => {
      const block = content.ownerDocument.createElement("div");
      block.append(...Array.from(quote.childNodes));
      quote.replaceWith(block);
    });
    content.querySelectorAll<HTMLElement>(`[${QUOTED_HTML_MARKER}]`).forEach((quote) => {
      quote.setAttribute("data-quote-border", "false");
      quote.style.borderLeft = "none";
      quote.style.paddingLeft = "0";
    });
    html = container.innerHTML;
  }
  const remote = opts.remoteAllowed ? ` ${QUOTED_REMOTE_ALLOWED_ATTR}="allowed"` : "";
  const borderAttribute = showQuoteBorder ? "" : ' data-quote-border="false"';
  const style = showQuoteBorder ? QUOTE_BAR_STYLE : "margin-top:8px;";
  return `<div ${QUOTED_HTML_MARKER}${remote}${borderAttribute} style="${style}">${html}</div>`;
}
