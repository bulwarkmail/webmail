/**
 * Finds text that's cut off at the side: a line of text that runs past the edge of
 * the nearest box that clips it (overflow other than visible), or past the window
 * when nothing clips it. A box's vertical scroll bar counts as its edge, so text
 * hidden behind a scroll bar is found too.
 *
 * Not counted: text that's meant to be cut (text-overflow: ellipsis, line clamp),
 * text inside a box that scrolls only sideways, text that's wholly outside its box (a
 * closed drawer, a slide), text in a box 1-2px wide (visually hidden), screen-reader-only text, and anything marked
 * data-layout-fit-ignore. Frames (a message body) aren't looked into. A field's
 * placeholder counts too, unless it ends in an ellipsis.
 */
import type { Page } from '@playwright/test';

export interface CutOff {
  /** Tag, test id and a few classes of the element holding the text. */
  where: string;
  text: string;
  /** How many CSS pixels are cut off. */
  px: number;
}

export async function findCutOffText(page: Page): Promise<CutOff[]> {
  return page.evaluate(() => {
    const out: { where: string; text: string; px: number }[] = [];
    const seen = new Set<Element>();
    const viewport = { left: 0, right: document.documentElement.clientWidth };
    const clipsX = (s: CSSStyleDeclaration) => s.overflowX !== 'visible';
    // A sideways scroller on purpose: one that scrolls sideways only. A box that
    // scrolls up and down computes overflow-x: auto as well, and text running off
    // its side is still cut off for anyone who doesn't think to scroll sideways.
    const scrollsX = (s: CSSStyleDeclaration) =>
      (s.overflowX === 'auto' || s.overflowX === 'scroll') && s.overflowY !== 'auto' && s.overflowY !== 'scroll';
    const describe = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
      return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ''}${cls ? `.${cls}` : ''}`;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      const el = node.parentElement;
      if (!text || !el || seen.has(el)) continue;
      if (el.closest('script, style, noscript, [aria-hidden="true"], .sr-only, [data-layout-fit-ignore]')) continue;
      const own = getComputedStyle(el);
      if (own.visibility === 'hidden' || own.display === 'none' || Number(own.opacity) === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
      if (rects.length === 0) continue;
      const textLeft = Math.min(...rects.map((r) => r.left));
      const textRight = Math.max(...rects.map((r) => r.right));

      let meant = false;
      let box: { left: number; right: number } | null = null;
      for (let at: Element | null = el; at && at !== document.documentElement; at = at.parentElement) {
        const s = getComputedStyle(at);
        if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) meant = true;
        if (Number(s.opacity) === 0 || s.visibility === 'hidden') { meant = true; break; }
        if (!clipsX(s)) continue;
        if (scrollsX(s)) { meant = true; break; }
        // A strip of pages that scrolls both ways (the calendar's weeks side by side):
        // the next page peeking in is meant. Text spilling over by accident is a few
        // pixels to a column, never half the box again.
        if (s.overflowX !== 'hidden' && s.overflowX !== 'clip' && at.scrollWidth > at.clientWidth * 1.5) { meant = true; break; }
        // A 1px box is the visually-hidden pattern: read out, not shown.
        if (at.clientWidth <= 2) { meant = true; break; }
        const r = at.getBoundingClientRect();
        const left = r.left + at.clientLeft;
        box = { left, right: left + at.clientWidth };
        break;
      }
      if (meant) continue;
      const edge = box ?? viewport;
      // Wholly outside: not cut, put away.
      if (textRight <= edge.left || textLeft >= edge.right) continue;
      const px = Math.max(textRight - edge.right, edge.left - textLeft);
      if (px > 1.5) {
        seen.add(el);
        out.push({ where: describe(el), text: text.slice(0, 60), px: Math.round(px) });
      }
    }
    // A placeholder cut off mid-word: "Termine durchs". With text-overflow: ellipsis
    // it ends in "…" and says there's more.
    const canvas = document.createElement('canvas').getContext('2d');
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder]'))) {
      if (input.value || !input.placeholder || input.closest('[aria-hidden="true"], [data-layout-fit-ignore]')) continue;
      const s = getComputedStyle(input);
      if (s.display === 'none' || s.visibility === 'hidden' || input.offsetParent === null) continue;
      if (s.textOverflow === 'ellipsis' || !canvas) continue;
      canvas.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const room = input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      const px = canvas.measureText(input.placeholder).width - room;
      if (px > 1.5) out.push({ where: describe(input), text: input.placeholder.slice(0, 60), px: Math.round(px) });
    }
    return out;
  });
}
