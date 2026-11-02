import { SIGNATURE_BLOCK_MARKER, SIGNATURE_RANGE_MARKER } from "@/components/email/signature-block";
import { QUOTED_HTML_MARKER } from "@/components/email/quoted-html";
import { REPLY_QUOTE_START_ATTRIBUTE } from "@/components/email/reply-quote-collapse";

/**
 * Empty lines in the composer (#1015).
 *
 * The composer writes one paragraph per line, so a blank line is an empty
 * paragraph. ProseMirror serializes that as `<p></p>`, which a browser or mail
 * client renders zero pixels high: the blank lines vanished for the recipient
 * and in the Sent folder. Browsers only show a block's last line when it holds
 * something, which is why Gmail and Thunderbird write `<p><br></p>`.
 *
 * The rule here mirrors the browser's: a <br> at the very end of a paragraph
 * doesn't show. On the way out every paragraph that is empty or ends in a line
 * break gets that extra <br>; on the way back in (re-opened draft, signature
 * swap) the parse rule below drops it again, so the editor content round-trips
 * without gaining a line each time.
 */

function lastChild(el: Element): ChildNode | null {
  let node = el.lastChild;
  while (node && node.nodeType === 3 && !(node.textContent ?? "").trim()) {
    node = node.previousSibling;
  }
  return node;
}

/**
 * Add the trailing <br> to every paragraph under `root` that would otherwise
 * lose its last line. The signature's range marker paragraphs stay as they
 * are: they only bracket the signature for the composer.
 */
export function addTrailingParagraphBreaks(root: ParentNode): void {
  root.querySelectorAll("p").forEach((p) => {
    if (p.hasAttribute(SIGNATURE_RANGE_MARKER)) return;
    const last = lastChild(p);
    if (!last || last.nodeName === "BR") {
      p.appendChild(p.ownerDocument.createElement("br"));
    }
  });
}

/**
 * Paragraph spacing (#1340).
 *
 * The composer shows paragraphs 4px apart (`.tiptap p` in globals.css, none
 * inside a table), but a sent `<p>` carries no style, so the Sent folder and
 * every recipient's client fall back to the browser's 1em margins and each
 * Enter looks like a blank line. Inline the composer's margin on the way out.
 * Paragraphs keep their `style` in the editor, so the parse side strips the
 * margin again (paragraphStyleWithoutSpacing) and a re-opened draft doesn't
 * stack one more margin per save.
 */
const PARAGRAPH_MARGIN = "margin:4px 0;";
const TABLE_PARAGRAPH_MARGIN = "margin:0;";

/** A paragraph that brings a margin of its own, from the mail it was loaded from. */
const OWN_MARGIN = /(?:^|;)\s*margin(?:-block)?(?:-start|-end|-top|-bottom)?\s*:/i;

export function addParagraphSpacing(root: ParentNode): void {
  root.querySelectorAll("p").forEach((p) => {
    if (p.hasAttribute(SIGNATURE_RANGE_MARKER)) return;
    const style = p.getAttribute("style") ?? "";
    // A paragraph that already states its spacing keeps it: the composer's
    // own margin would only be overridden by it anyway, and writing both
    // leaves two margin declarations in every line of the sent mail.
    if (OWN_MARGIN.test(style)) return;
    const margin = p.closest("table") ? TABLE_PARAGRAPH_MARGIN : PARAGRAPH_MARGIN;
    // Ahead of any style the editor wrote, so an explicit margin still wins.
    p.setAttribute("style", margin + style);
  });
}

/**
 * Spacing of a message the composer did not write (#1416).
 *
 * A draft does not have to come from this composer: the JMAP API, another
 * client, an automation or a template can put one in the Drafts folder, and
 * its paragraphs carry no style, so every mail client lays them out with the
 * user agent's 1em margins. The composer shows its own paragraphs 4px apart
 * and sends that spacing out (#1340), so opening such a draft to proofread it
 * and pressing Send re-flowed a message nobody meant to re-flow.
 *
 * Materialise the spacing a loaded paragraph already has, so the editor shows
 * the message's own layout and what goes out is what came in. Only paragraphs
 * with content are stamped: the empty one a new message is scaffolded with has
 * no spacing to preserve, and the paragraphs the user then writes should
 * follow the composer like every other line they type.
 */
const MAIL_PARAGRAPH_MARGIN = "margin:1em 0;";

export function keepLoadedParagraphSpacing(html: string): string {
  if (!html.includes("<p")) return html;
  // A template is inert: parsed into a live element, the quoted original's
  // remote images (trackers) would load in the app document right here,
  // whatever the remote-content setting or the organisation's lock says.
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  let stamped = false;
  root.querySelectorAll("p").forEach((p) => {
    if (p.hasAttribute(SIGNATURE_RANGE_MARKER)) return;
    // The quoted original and an embedded signature are held verbatim by
    // their own nodes - neither is laid out by the composer.
    if (p.closest(`[${QUOTED_HTML_MARKER}], [${SIGNATURE_BLOCK_MARKER}]`)) return;
    // The reply's attribution line is the composer's own (#1405).
    if (p.hasAttribute(REPLY_QUOTE_START_ATTRIBUTE)) return;
    // A paragraph in a table cell sits flush in the composer and in the mail.
    if (p.closest("table")) return;
    if (!(p.textContent ?? "").trim() && !p.querySelector("img")) return;
    const style = p.getAttribute("style") ?? "";
    if (OWN_MARGIN.test(style)) return;
    p.setAttribute("style", MAIL_PARAGRAPH_MARGIN + style);
    stamped = true;
  });
  return stamped ? template.innerHTML : html;
}

/** A paragraph's `style` without the margin addParagraphSpacing put in front. */
export function paragraphStyleWithoutSpacing(el: HTMLElement): string | null {
  const style = el.getAttribute("style");
  if (style === null) return null;
  for (const margin of [PARAGRAPH_MARGIN, TABLE_PARAGRAPH_MARGIN]) {
    if (style.startsWith(margin)) return style.slice(margin.length).trim() || null;
  }
  return style;
}

/** Whether `el` is the <br> a paragraph ends on, which a browser doesn't show. */
export function isTrailingParagraphBreak(el: HTMLElement): boolean {
  if (el.parentElement?.nodeName !== "P") return false;
  return lastChild(el.parentElement) === el;
}

/**
 * Parse rule for the paragraph node: skip the invisible trailing <br> instead
 * of turning it into a hard break. Ranks above the hard break's own rule.
 */
export const trailingParagraphBreakRule = {
  tag: "br",
  priority: 60,
  ignore: true,
  getAttrs: (el: HTMLElement) => (isTrailingParagraphBreak(el) ? null : false),
} as const;
