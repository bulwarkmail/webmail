import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepLoadedParagraphSpacing } from '../paragraph-breaks';

// Loading a reply or a re-opened draft into the composer goes through
// keepLoadedParagraphSpacing. It must parse the HTML inertly: an <img> parsed
// into an element of the app document starts loading at once, so a quoted
// message's tracking pixel fired the moment the composer opened, also while
// the organisation blocks remote content (found by the enterprise spec).

afterEach(() => vi.restoreAllMocks());

describe('keepLoadedParagraphSpacing', () => {
  it('never puts the message into the live document', () => {
    const created: Element[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const el = original(tag, options);
      created.push(el);
      return el;
    }) as typeof document.createElement);

    const html = '<p>Thanks</p><div data-quoted-html=""><p>Hi <img src="https://tracker.example/p.gif"></p></div>';
    const out = keepLoadedParagraphSpacing(html);

    const liveImages = created.flatMap((el) => [...el.querySelectorAll('img')]).filter((img) => img.ownerDocument === document);
    expect(liveImages).toEqual([]);
    // It still does its job.
    expect(out).toContain('<p style="margin:1em 0;">Thanks</p>');
    expect(out).toContain('<img src="https://tracker.example/p.gif">');
  });
});
