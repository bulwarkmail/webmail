import { describe, expect, it } from 'vitest';
import { buildEmailBodyForSet } from '@/lib/jmap/build-email-body';

describe('buildEmailBodyForSet', () => {
  it('keeps flat multipart/alternative when there are no inline CID parts', () => {
    const built = buildEmailBodyForSet({
      textBody: 'Hello',
      htmlBody: '<p>Hello</p>',
      attachments: [
        {
          blobId: 'blob-file',
          name: 'doc.pdf',
          type: 'application/pdf',
          size: 100,
          disposition: 'attachment',
        },
      ],
    });

    expect(built.bodyStructure).toBeUndefined();
    expect(built.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
    expect(built.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
    expect(built.attachments).toHaveLength(1);
  });

  it('nests inline CID images under multipart/related with HTML', () => {
    const built = buildEmailBodyForSet({
      textBody: 'Hello',
      htmlBody: '<p>Hi <img src="cid:img-1@webmail"></p>',
      attachments: [
        {
          blobId: 'blob-img',
          name: 'logo.png',
          type: 'image/png',
          size: 512,
          disposition: 'inline',
          cid: 'img-1@webmail',
        },
      ],
    });

    expect(built.attachments).toBeUndefined();
    expect(built.textBody).toBeUndefined();
    expect(built.bodyStructure).toEqual({
      type: 'multipart/alternative',
      subParts: [
        { partId: 'text', type: 'text/plain' },
        {
          type: 'multipart/related',
          subParts: [
            { partId: 'html', type: 'text/html' },
            {
              blobId: 'blob-img',
              type: 'image/png',
              name: 'logo.png',
              disposition: 'inline',
              cid: 'img-1@webmail',
              size: 512,
            },
          ],
        },
      ],
    });
    expect(built.bodyValues).toEqual({
      text: { value: 'Hello' },
      html: { value: '<p>Hi <img src="cid:img-1@webmail"></p>' },
    });
  });

  it('wraps alternative+related in multipart/mixed when regular attachments exist', () => {
    const built = buildEmailBodyForSet({
      textBody: 'Hello',
      htmlBody: '<p>Hi</p>',
      attachments: [
        {
          blobId: 'blob-img',
          name: 'logo.png',
          type: 'image/png',
          size: 512,
          disposition: 'inline',
          cid: 'img-1@webmail',
        },
        {
          blobId: 'blob-pdf',
          name: 'doc.pdf',
          type: 'application/pdf',
          size: 900,
          disposition: 'attachment',
        },
      ],
    });

    expect(built.bodyStructure).toEqual({
      type: 'multipart/mixed',
      subParts: [
        {
          type: 'multipart/alternative',
          subParts: [
            { partId: 'text', type: 'text/plain' },
            {
              type: 'multipart/related',
              subParts: [
                { partId: 'html', type: 'text/html' },
                {
                  blobId: 'blob-img',
                  type: 'image/png',
                  name: 'logo.png',
                  disposition: 'inline',
                  cid: 'img-1@webmail',
                  size: 512,
                },
              ],
            },
          ],
        },
        {
          blobId: 'blob-pdf',
          type: 'application/pdf',
          name: 'doc.pdf',
          disposition: 'attachment',
          size: 900,
        },
      ],
    });
  });

  it('treats cid without explicit disposition as inline when HTML is present', () => {
    const built = buildEmailBodyForSet({
      textBody: 'Hello',
      htmlBody: '<img src="cid:img-1@webmail">',
      attachments: [
        {
          blobId: 'blob-img',
          name: 'logo.png',
          type: 'image/png',
          size: 100,
          cid: 'img-1@webmail',
        },
      ],
    });

    const related = (built.bodyStructure as { subParts: unknown[] }).subParts[1] as {
      subParts: Array<{ cid?: string }>;
    };
    expect(related.subParts[1]?.cid).toBe('img-1@webmail');
  });
});
