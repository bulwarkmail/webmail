import { describe, it, expect } from 'vitest';
import { getRenderableHtmlBody, getDraftTextBody, getDraftComposerBody } from '@/lib/email-body-selection';

type PartialEmail = Parameters<typeof getRenderableHtmlBody>[0];

function makeEmail(parts: {
  html?: { partId: string; type: string };
  text?: { partId: string; type: string };
  values: Record<string, string>;
}): PartialEmail {
  const part = (p: { partId: string; type: string }) => ({
    partId: p.partId,
    blobId: `blob-${p.partId}`,
    size: 1,
    type: p.type,
  });
  return {
    htmlBody: parts.html ? [part(parts.html)] : [],
    textBody: parts.text ? [part(parts.text)] : [],
    bodyValues: Object.fromEntries(
      Object.entries(parts.values).map(([k, v]) => [k, { value: v, isEncodingProblem: false, isTruncated: false }])
    ),
  } as PartialEmail;
}

describe('getRenderableHtmlBody', () => {
  it('renders as plain text when the shared part is text/plain (#489)', () => {
    // Plain-text-only mail: RFC 8621 puts the same part in htmlBody and textBody.
    const email = makeEmail({
      html: { partId: '1', type: 'text/plain' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'line one\nline two\nline three' },
    });

    expect(getRenderableHtmlBody(email)).toBeNull();
  });

  it('matches the media type case-insensitively', () => {
    const email = makeEmail({
      html: { partId: '1', type: 'TEXT/HTML' },
      text: { partId: '1', type: 'TEXT/HTML' },
      values: { '1': '<p>hello</p>' },
    });

    expect(getRenderableHtmlBody(email)).toBe('<p>hello</p>');
  });

  it('renders HTML-only mail as HTML even though the part is shared', () => {
    const email = makeEmail({
      html: { partId: '1', type: 'text/html' },
      text: { partId: '1', type: 'text/html' },
      values: { '1': '<div><b>rich</b> content</div>' },
    });

    expect(getRenderableHtmlBody(email)).toBe('<div><b>rich</b> content</div>');
  });

  it('prefers the distinct text part when the HTML alternative is a bare wrapper', () => {
    const email = makeEmail({
      html: { partId: '2', type: 'text/html' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'line one\nline two', '2': '<html><body>line one line two</body></html>' },
    });

    expect(getRenderableHtmlBody(email)).toBeNull();
  });

  it('keeps a distinct HTML alternative that carries real formatting', () => {
    const html = '<html><body><p>line one</p><p><b>line two</b></p></body></html>';
    const email = makeEmail({
      html: { partId: '2', type: 'text/html' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'line one\nline two', '2': html },
    });

    expect(getRenderableHtmlBody(email)).toBe(html);
  });

  it('returns null when there is no HTML body at all', () => {
    const email = makeEmail({
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'just text' },
    });

    expect(getRenderableHtmlBody(email)).toBeNull();
  });

  it('returns null when the HTML part has no fetched body value', () => {
    const email = makeEmail({
      html: { partId: '2', type: 'text/html' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'just text' },
    });

    expect(getRenderableHtmlBody(email)).toBeNull();
  });

  it('returns null for an empty HTML body value', () => {
    const email = makeEmail({
      html: { partId: '2', type: 'text/html' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'just text', '2': '' },
    });

    expect(getRenderableHtmlBody(email)).toBeNull();
  });
});

/**
 * Re-opening a draft used to join every value in bodyValues into the
 * message. getEmail asks for fetchAllBodyValues, which per RFC 8621
 * covers every text/* part including attachments, so a draft carrying
 * only a .csv re-opened with the contents of that .csv as its text - and
 * the next save made that the real message.
 */
describe('getDraftTextBody', () => {
  type DraftEmail = Parameters<typeof getDraftTextBody>[0];

  const draft = (textBody: { partId: string }[], values: Record<string, string>): DraftEmail => ({
    textBody: textBody as DraftEmail['textBody'],
    bodyValues: Object.fromEntries(
      Object.entries(values).map(([id, value]) => [id, { value, isEncodingProblem: false, isTruncated: false }]),
    ) as DraftEmail['bodyValues'],
  });

  it('takes the body from the parts listed as the body', () => {
    expect(getDraftTextBody(draft([{ partId: '1' }], { '1': 'hello' }))).toBe('hello');
  });

  it('ignores a text attachment that is not part of the body', () => {
    // Part 2 is an attached text/csv: fetchAllBodyValues returns its value
    // too, but it is not in textBody and is not the message.
    const d = draft([{ partId: '1' }], { '1': 'see attached', '2': 'Date,Amount\n2026-08-30,12.00' });
    expect(getDraftTextBody(d)).toBe('see attached');
  });

  it('is empty for a draft that has attachments and no body at all', () => {
    expect(getDraftTextBody(draft([], { '2': 'Date,Amount\n2026-08-30,12.00' }))).toBe('');
  });

  it('joins several body parts', () => {
    expect(getDraftTextBody(draft([{ partId: '1' }, { partId: '2' }], { '1': 'one', '2': 'two' })))
      .toBe('one\ntwo');
  });

  it('survives a part whose value the server did not return', () => {
    expect(getDraftTextBody(draft([{ partId: '1' }, { partId: '9' }], { '1': 'one' }))).toBe('one');
  });
});

describe('getDraftComposerBody', () => {
  it('opens a text-only draft as plain text', () => {
    // Plain-text-only draft: the text/plain part is listed under htmlBody too.
    const email = makeEmail({
      html: { partId: '1', type: 'text/plain' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'Hi <you>,\n\nbye' },
    });
    expect(getDraftComposerBody(email)).toEqual({ body: 'Hi <you>,\n\nbye', bodyText: 'Hi <you>,\n\nbye', plainTextMode: true });
  });

  it('opens an HTML draft in the rich editor', () => {
    const email = makeEmail({
      html: { partId: '2', type: 'text/html' },
      text: { partId: '1', type: 'text/plain' },
      values: { '1': 'Hi', '2': '<p>Hi</p>' },
    });
    expect(getDraftComposerBody(email)).toEqual({ body: '<p>Hi</p>', bodyText: 'Hi', plainTextMode: false });
  });

  it('leaves the format of an empty draft to the setting', () => {
    expect(getDraftComposerBody(makeEmail({ values: {} })).plainTextMode).toBeUndefined();
  });
});
