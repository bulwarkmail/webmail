/**
 * Links in a message frame (the reader and the conversation view) only go
 * live once the app has wired its link gate to the frame's document.
 *
 * The frames run without allow-scripts. The gate is a click listener the
 * app adds to the frame's document from outside, and WebKit (Safari, every
 * browser on iOS) never calls listeners on a document that may not run
 * scripts, not even the parent's. A link there would open its raw address
 * past onBeforeExternalLink, the cid: part gate and the href check.
 *
 * So the frame's HTML carries every link's address in HELD_HREF_ATTR and no
 * href (holdFrameLinks): until the app wires the frame, nothing opens. Then
 * releaseFrameLinks probes whether the frame's listeners run. Where they do
 * (Chromium, Firefox), every href comes back as it was and the click
 * listener gates it as before. Where they don't, each link gets the address
 * `route` gives it, one the browser can only reach through a gate of the
 * app's own, or stays without an href.
 *
 * The sanitizer drops every data-* attribute a sender writes, so a mail
 * can't plant HELD_HREF_ATTR itself.
 */

/** Where a held link keeps its address until the frame is wired. */
export const HELD_HREF_ATTR = 'data-bulwark-href';

/**
 * Held links look like links until they are released: a link without an
 * href loses the browser's own link colour and underline. Zero
 * specificity, so any colour the mail sets for its links still wins.
 */
export const HELD_LINK_CSS = `:where(a[${HELD_HREF_ATTR}], area[${HELD_HREF_ATTR}]){color:LinkText;text-decoration:underline;cursor:pointer}`;

const LINKS = 'a[href], area[href]';
const HELD_LINKS = `a[${HELD_HREF_ATTR}], area[${HELD_HREF_ATTR}]`;

/**
 * The frame's body HTML with every link's href moved into HELD_HREF_ATTR.
 * Only for the frame: print and plugins keep the sanitized HTML as it is.
 */
export function holdFrameLinks(html: string): string {
  // The frames render in the browser only; without a DOM nothing is shown.
  if (typeof document === 'undefined') return '';
  if (!/<(?:a|area)\b/i.test(html)) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll(LINKS).forEach((link) => {
    link.setAttribute(HELD_HREF_ATTR, link.getAttribute('href') ?? '');
    link.removeAttribute('href');
  });
  return template.innerHTML;
}

/**
 * Whether listeners the app adds to `doc` run. False in WebKit for a frame
 * sandboxed without allow-scripts, where a click listener would never see
 * the click either.
 */
export function frameListenersRun(doc: Document): boolean {
  const type = 'bulwark-listener-probe';
  let ran = false;
  const probe = () => { ran = true; };
  doc.addEventListener(type, probe, true);
  try {
    const EventCtor = doc.defaultView?.Event ?? Event;
    doc.dispatchEvent(new EventCtor(type));
  } catch {
    // Can't tell: treat it as not running, the safe side.
  } finally {
    doc.removeEventListener(type, probe, true);
  }
  return ran;
}

/** A link the gate is asked about when the frame's listeners don't run. */
export type FrameLinkRoute = (link: HTMLAnchorElement | HTMLAreaElement, href: string) => string | null;

/**
 * Give the held links in `doc` their addresses. 'listener': the frame's
 * listeners run, every href is back as it was and the caller's click
 * listener is the gate. 'routed': they don't, and each link has what
 * `route` returned (a link that opens in a new tab when it's a web
 * address), or no href when it returned null.
 */
export function releaseFrameLinks(doc: Document, route: FrameLinkRoute): 'listener' | 'routed' {
  const held = Array.from(doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(HELD_LINKS));
  const listenersRun = frameListenersRun(doc);
  for (const link of held) {
    const href = link.getAttribute(HELD_HREF_ATTR) ?? '';
    link.removeAttribute(HELD_HREF_ATTR);
    if (listenersRun) {
      link.setAttribute('href', href);
      continue;
    }
    let target: string | null = null;
    try {
      target = route(link, href);
    } catch {
      target = null;
    }
    if (target === null) continue;
    link.setAttribute('href', target);
    if (/^https?:/i.test(target)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return listenersRun ? 'listener' : 'routed';
}
