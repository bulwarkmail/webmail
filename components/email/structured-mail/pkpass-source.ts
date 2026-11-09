import { PKPASS_MAX_BYTES, PKPASS_MAX_PER_MAIL, isPkpassAttachment, readPkpass } from '@/lib/structured-mail/pkpass';
import type { StructuredCard } from '@/lib/structured-mail';
import type { CardSource } from './sources';

/**
 * Cards from Apple Wallet passes attached to a trusted message. Reads only
 * `email.attachments`, the message's own parts: never the parts the viewer
 * unwraps from an attached .eml or a TNEF winmail.dat, which the sender's
 * authentication says nothing about. At most three passes, each downloaded
 * from the message's own JMAP account and capped at 5 MB; stops between
 * downloads once the message is closed. Never throws.
 */
export const pkpassSource: CardSource = async ({ email, mailDate, blob, signal }) => {
  try {
    const { client, accountId } = blob;
    if (!client || signal.aborted) return [];
    const attachments = (Array.isArray(email.attachments) ? email.attachments : [])
      .filter((att) => !!att && typeof att.blobId === 'string' && att.blobId !== '' && isPkpassAttachment(att))
      .slice(0, PKPASS_MAX_PER_MAIL);
    const cards: StructuredCard[] = [];
    for (const att of attachments) {
      if (signal.aborted) return [];
      let bytes: ArrayBuffer;
      try {
        // One byte past the cap, so a blob larger than its listed size is noticed and refused.
        bytes = await client.fetchBlobArrayBuffer(att.blobId, att.name, att.type, accountId, PKPASS_MAX_BYTES + 1);
      } catch {
        continue;
      }
      cards.push(...await readPkpass(bytes, { mailDate }));
    }
    return signal.aborted ? [] : cards;
  } catch {
    return [];
  }
};
