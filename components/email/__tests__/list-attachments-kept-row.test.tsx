import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { Attachment, Email } from '@/lib/jmap/types';
import type { LoadListAttachments } from '@/lib/list-attachments';
import { useListHasAttachment } from '../attachment-chips';

// The list keeps a row on screen for the next message at its place (a folder
// switch, a search). The row's paperclip has to follow the cached answer for
// the message it shows now from its first render: the last message's state
// showed the paperclip for a frame on a mail whose parts are all inline.

const mail = (id: string) => ({ id, hasAttachment: true }) as unknown as Email;
const logo = { partId: '2', blobId: 'b2', name: 'logo.png', type: 'image/png', size: 300, disposition: 'inline', cid: 'logo' } as unknown as Attachment;
const report = { partId: '3', blobId: 'b3', name: 'report.pdf', type: 'application/pdf', size: 9000, disposition: 'attachment' } as unknown as Attachment;

describe('a kept row and its paperclip', () => {
  it('reads the cache for the message it shows now', () => {
    const cache = new Map<string, Attachment[]>([['a', [report]], ['b', [logo]]]);
    // As requestListAttachments does: a cached answer comes at once.
    const load = Object.assign(
      (email: Email, onLoad: (attachments: Attachment[]) => void) => {
        const cached = cache.get(email.id);
        if (cached) onLoad(cached);
        return () => {};
      },
      { peek: (email: Email) => cache.get(email.id) },
    ) as unknown as LoadListAttachments;
    const seen: boolean[] = [];
    const { rerender } = renderHook(({ email }) => {
      const shows = useListHasAttachment(email, load);
      seen.push(shows);
      return shows;
    }, { initialProps: { email: mail('a') } });
    expect(seen.at(-1)).toBe(true);
    seen.length = 0;
    rerender({ email: mail('b') });
    // Every render for "b", the first one included: only an inline logo.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual(seen.map(() => false));
  });
});
