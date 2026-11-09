/**
 * The shared Support mailbox (support@meridianlabs.example). It belongs to a
 * separate principal that has delegated it to Nora, so it shows up under her
 * own folders as a shared account, and in the merged inbox with its own badge.
 *
 * The `$label:` keywords are the team's shared tags (fixtures/shared-metadata.ts).
 * `$assigned:<principal id>` and `$done` are the team inbox plugin's
 * (repos/plugins team-inbox/src/lib/keywords.js): Tomás's question is
 * Nora's, the departed employee's login is Bob's, and Yusuf's thread is
 * done.
 */
import type { Email } from '@/lib/jmap/types';
import { ago, at, authPass, dayName, mail, mid } from './mail';
import { SMB } from './mailboxes';
import { addr, SUPPORT, NORA, TOMAS, LENA, YUSUF } from './people';

const support = addr(SUPPORT);

export function createDemoSupportEmails(): Email[] {
  return [
    mail({
      id: 'demo-support-tomas', mailbox: SMB.inbox, date: ago(0, 55),
      from: addr(TOMAS), to: [support],
      subject: 'Beacon add-on: can we go to 100 tenants before launch?',
      keywords: ['$label:billing', '$assigned:demo-account'],
      text: 'Hello,\n\nOur PO covers fifty tenants on the Beacon add-on. Operations now wants all hundred Lisbon tenants on it from day one. Can the add-on be raised before the launch, and does that change the canary plan Nora mentioned?\n\nThank you,\nTomás Ferreira\nLumen Logistics',
      headers: authPass('lumenlogistics.example'),
    }),
    mail({
      id: 'demo-support-lena-address', mailbox: SMB.inbox, date: at(1, 11, 18),
      from: addr(LENA), to: [support],
      subject: 'Invoice address change',
      keywords: ['$label:billing'],
      text: 'Dear Meridian team,\n\nPlease send future invoices to our new address:\n\nHoffmann & Partner Steuerberatung\nFriedrichstraße 200\n10117 Berlin\n\nThe VAT id stays the same. Could you confirm once it is changed?\n\nKind regards,\nLena Hoffmann',
      headers: authPass('hoffmann-partner.example'),
    }),
    mail({
      id: 'demo-support-yusuf-2', thread: 'demo-support-thread-yusuf', mailbox: SMB.inbox, date: at(1, 9, 5),
      from: addr(YUSUF), to: [support],
      subject: 'Re: Webhook signature verification in PHP?',
      text: 'That worked, thank you! The timestamp tolerance was the missing piece. You can close this.\n\nYusuf',
      keywords: ['$seen', '$label:integration', '$assigned:demo-account', '$done'],
      headers: authPass('demir-retail.example'),
      inReplyTo: [mid('demo-support-yusuf-reply')], references: [mid('demo-support-yusuf-1', 'demir-retail.example'), mid('demo-support-yusuf-reply')],
    }),
    mail({
      id: 'demo-support-yusuf-1', thread: 'demo-support-thread-yusuf', mailbox: SMB.inbox, date: at(2, 15, 42),
      from: addr(YUSUF), to: [support],
      subject: 'Webhook signature verification in PHP?',
      text: 'Hi,\n\nWe are testing the Beacon beta. The docs show signature verification in Node and Python; is there a PHP example? Our shop runs on Laravel. Verification fails for us with "timestamp outside tolerance", although the clocks look fine.\n\nYusuf Demir\nDemir Retail',
      keywords: ['$seen', '$label:integration'],
      headers: authPass('demir-retail.example'),
    }),
    mail({
      id: 'demo-support-lena-reset', mailbox: SMB.inbox, date: at(3, 10, 2),
      from: addr(LENA), to: [support],
      subject: 'Access for a departed employee',
      text: `Hello,\n\nA colleague left us at the end of last month and still has an active login to our Meridian workspace. Could you disable it? The address is j.becker@hoffmann-partner.example. I am the account owner.\n\nThank you,\nLena Hoffmann`,
      keywords: ['$seen', '$label:accounts', '$assigned:demo-bob'],
      headers: authPass('hoffmann-partner.example'),
    }),

    // Nora answered Yusuf from the shared mailbox.
    mail({
      id: 'demo-support-yusuf-reply', thread: 'demo-support-thread-yusuf', mailbox: SMB.sent, date: at(2, 16, 30),
      from: support, to: [addr(YUSUF)],
      subject: 'Re: Webhook signature verification in PHP?',
      text: `Hi Yusuf,\n\nThere is no PHP example in the docs yet; one is coming with the launch. Until then, the two things that usually go wrong:\n\n1. Sign the raw request body, not the decoded JSON.\n2. The timestamp in X-Beacon-Timestamp is in seconds, and the tolerance is five minutes. "Outside tolerance" nearly always means the body was re-encoded or the header was read as milliseconds.\n\nA minimal example:\n\n  $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);\n  hash_equals($expected, $signature);\n\nTell me if that does not fix it and I will look at a request with you.\n\nNora, for Meridian Support`,
      keywords: ['$seen', '$label:integration'],
      inReplyTo: [mid('demo-support-yusuf-1', 'demir-retail.example')], references: [mid('demo-support-yusuf-1', 'demir-retail.example')],
    }),

    mail({
      id: 'demo-support-resolved-sso', mailbox: SMB.resolved, date: at(9, 13, 20),
      from: { name: 'Petra Novak', email: 'petra@novak-consulting.example' }, to: [support],
      subject: 'Re: SSO login loop after the provider change',
      text: `Confirmed fixed on our side, thank you for the quick turnaround ${dayName(-9)}.\n\nPetra`,
      keywords: ['$seen', '$label:bug'], headers: authPass('novak-consulting.example'),
    }),
  ];
}

/** The persona's address inside the shared mailbox, for the identity list. */
export const SUPPORT_SENDER = { name: `${NORA.given} (Meridian Support)`, email: SUPPORT.email };
