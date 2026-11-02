/**
 * Links in a message the user reported as phishing ($phishing, RFC 9051
 * §2.3.2: clients should warn and disable links) are turned off: each
 * `<a>` and `<area>` loses its address, so it can't be clicked, opened in
 * a new tab or reached with Tab, and says that it is off. Runs on the
 * sanitised body, before it goes into the reader's frame.
 */

import type { Email } from '@/lib/jmap/types';
import { PHISHING_KEYWORD } from '@/lib/phishing-report';

/** Whether the message carries the phishing mark. */
export function isPhishingMarked(email: Pick<Email, 'keywords'> | null | undefined): boolean {
  return email?.keywords?.[PHISHING_KEYWORD] === true;
}

const LINK_OFF_STYLE = 'color:inherit !important;text-decoration:underline dotted !important;cursor:not-allowed !important';

/** What a turned-off link says: its tooltip, and the note a screen reader hears after its text. */
export interface LinksOffText {
  title: string;
  note: string;
}

/** `html` with every link turned off. */
export function turnOffLinks(html: string, text: LinksOffText): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  if (!/<(a|area)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = doc.querySelectorAll('a, area');
  if (links.length === 0) return html;
  links.forEach((link) => {
    for (const name of ['href', 'xlink:href', 'target', 'rel', 'ping', 'download', 'tabindex']) link.removeAttribute(name);
    link.setAttribute('data-link-off', '');
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('title', text.title);
    if (link.tagName === 'A') {
      // Looks like text that was a link; a screen reader hears the note.
      const style = link.getAttribute('style');
      link.setAttribute('style', `${style ? `${style};` : ''}${LINK_OFF_STYLE}`);
      const note = doc.createElement('span');
      note.setAttribute('data-link-off-note', '');
      note.setAttribute('style', 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap');
      note.textContent = ` ${text.note}`;
      link.appendChild(note);
    }
  });
  // A full document keeps its <head> (styles); a fragment stays a fragment.
  return /<html[\s>]/i.test(html) ? doc.documentElement.outerHTML : doc.body.innerHTML;
}
