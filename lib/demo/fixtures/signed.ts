/**
 * Alice's S/MIME signed sign-off of the Beacon security review. The raw
 * message is public/demo/beacon-security-signoff.eml (fixtures/assets.ts):
 * the S/MIME plugin fetches it by the Email's blobId and verifies the
 * detached signature over the text part, so the fixture describes that
 * file: multipart/signed with the text part and smime.p7s, and the same
 * text. Without the plugin the message reads as plain text with the
 * signature as an attachment, as on a server.
 */
import type { Email } from '@/lib/jmap/types';
import { attachment } from './assets';
import { at, authPass, mail } from './mail';
import { MB } from './mailboxes';
import { addr, ALICE, MICHAEL, WORK_DOMAIN } from './people';

export const SIGNED_EMAIL_ID = 'demo-email-smime-signoff';
export const SIGNED_EML_BLOB = 'demo-blob-security-signoff';
const BOUNDARY = '----=_Part_7731_BeaconSecurityReview';

/** The signed text part, as in the .eml (there with CRLF line ends). */
export const SIGNED_TEXT = `Hi Nora,

I went through the Beacon security review this morning. All four findings
from the pen test are fixed and retested:

1. Webhook secrets are rotated on every key roll (BEA-377).
2. The admin API rejects tokens older than 24 hours (BEA-381).
3. Signature checks compare in constant time (BEA-384).
4. Tenant ids in the logs are hashed (BEA-390).

From the security side Beacon is cleared for general availability. I signed
this mail so it can go into the launch record as it is.

Alice

--
Alice Johnson
Engineering Manager, Meridian Labs
`;

export function createDemoSignedEmails(): Email[] {
  const signature = attachment('demo-blob-security-signoff-p7s', { partId: 'smime-p7s' });
  const email = mail({
    id: SIGNED_EMAIL_ID, mailbox: MB.inbox, date: at(1, 11, 24),
    from: addr(ALICE), cc: [addr(MICHAEL)],
    subject: 'Beacon security review: signed off',
    text: SIGNED_TEXT,
    attachments: [signature],
    keywords: ['$seen', '$label:beacon'],
    headers: {
      ...authPass(WORK_DOMAIN),
      'Content-Type': `multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${BOUNDARY}"`,
    },
  });
  const text = email.textBody![0];
  return [{
    ...email,
    size: 4054,
    blobId: SIGNED_EML_BLOB,
    bodyStructure: {
      partId: '0', blobId: `${SIGNED_EML_BLOB}-body`, size: 4054, type: 'multipart/signed',
      subParts: [
        { ...text, charset: 'utf-8' },
        { ...signature, disposition: 'attachment' },
      ],
    },
  }];
}
