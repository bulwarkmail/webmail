/**
 * The Meridian Labs directory on the demo's server: a principal for every
 * colleague in the cast and one group, Support, whose mailbox is delegated
 * to Nora (fixtures/support.ts). Stalwart uses an account's id as its
 * principal id, so Nora's principal is her work account and the Support
 * group's is the shared Support account. People outside the company
 * (customers, friends) are no principals here.
 *
 * Also what Nora has shared with whom, as `shareWith` grants the Delegates
 * page (Settings > Sharing) lists: Alice can read her Inbox while Nora is
 * away.
 */
import type { MailboxRights, Principal } from '@/lib/jmap/types';
import { MAILBOX_PRESETS } from '@/lib/jmap/share-rights';
import { MB, SUPPORT_ACCOUNT_ID } from './mailboxes';
import {
  type Person,
  NORA, ALICE, BOB, PRIYA, AHMED, JAMES, MICHAEL, RACHEL, WEI, MARIA, LISA, SUPPORT,
} from './people';

/** Principal ids. Nora's is the work login's account id (demo-data.ts DEMO_WORK_ACCOUNT_ID). */
export const PRINCIPAL = {
  nora: 'demo-account',
  alice: 'demo-alice',
  bob: 'demo-bob',
  priya: 'demo-priya',
  ahmed: 'demo-ahmed',
  james: 'demo-james',
  michael: 'demo-michael',
  rachel: 'demo-rachel',
  wei: 'demo-wei',
  maria: 'demo-maria',
  lisa: 'demo-lisa',
  support: SUPPORT_ACCOUNT_ID,
} as const;

const TZ = 'Europe/Berlin';

const individual = (id: string, person: Person): Principal => ({
  id, type: 'individual', name: person.name, description: person.name, email: person.email, timeZone: TZ, accountId: id,
});

export function createDemoPrincipals(): Principal[] {
  return [
    individual(PRINCIPAL.nora, NORA),
    individual(PRINCIPAL.alice, ALICE),
    individual(PRINCIPAL.bob, BOB),
    individual(PRINCIPAL.priya, PRIYA),
    individual(PRINCIPAL.ahmed, AHMED),
    individual(PRINCIPAL.james, JAMES),
    individual(PRINCIPAL.michael, MICHAEL),
    individual(PRINCIPAL.rachel, RACHEL),
    individual(PRINCIPAL.wei, WEI),
    individual(PRINCIPAL.maria, MARIA),
    individual(PRINCIPAL.lisa, LISA),
    {
      id: PRINCIPAL.support, type: 'group', name: SUPPORT.name, description: 'Customer support, answered by the Platform team',
      email: SUPPORT.email, timeZone: TZ, accountId: PRINCIPAL.support,
    },
  ];
}

/** Grants on Nora's own folders, by folder id: Alice reads the Inbox while Nora is in Lisbon. */
export function createDemoMailboxShares(): Record<string, Record<string, MailboxRights>> {
  return {
    [MB.inbox]: { [PRINCIPAL.alice]: { ...MAILBOX_PRESETS.read } },
  };
}
