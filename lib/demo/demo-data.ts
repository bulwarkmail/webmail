import { cloneFixtures } from './demo-utils';
import { createDemoMailboxes, createDemoSupportMailboxes, createDemoPersonalMailboxes, SUPPORT_ACCOUNT_ID, SUPPORT_ACCOUNT_NAME } from './fixtures/mailboxes';
import { createDemoEmails } from './fixtures/emails';
import { createDemoSupportEmails } from './fixtures/support';
import { createDemoSignedEmails } from './fixtures/signed';
import { createDemoSupplierEmails } from './fixtures/supplier';
import { createDemoTravelEmails } from './fixtures/travel';
import { createDemoPersonalEmails, createDemoPersonalIdentities } from './fixtures/personal';
import { createDemoContacts, createDemoAddressBooks, createDemoPersonalContacts, createDemoPersonalAddressBooks } from './fixtures/contacts';
import { createDemoCalendars, createDemoCalendarEvents } from './fixtures/calendars';
import { createDemoCalendarTasks } from './fixtures/tasks';
import { createDemoIdentities } from './fixtures/identities';
import { createDemoSieveScripts, createDemoSieveCapabilities, createDemoSieveContent } from './fixtures/filters';
import { createDemoFileNodes } from './fixtures/files';
import { createDemoVacationResponse } from './fixtures/vacation';
import { NORA, NORA_PERSONAL } from './fixtures/people';
import { createDemoMailboxShares } from './fixtures/directory';

import type { Email, EmailAddress, Mailbox, ContactCard, AddressBook, Calendar, CalendarEvent, CalendarTask, Identity, VacationResponse, FileNode, SharedAccount } from '@/lib/jmap/types';
import type { SieveScript, SieveCapabilities } from '@/lib/jmap/sieve-types';

/**
 * The demo signs in to two accounts. "work" is the primary login with mail,
 * contacts, calendars, files and filters, plus the shared Support mailbox
 * delegated to it. "personal" is a second login with mail and contacts, so
 * the account switcher and the merged inbox have more than one source.
 */
export type DemoProfile = 'work' | 'personal';

export interface DemoData {
  profile: DemoProfile;
  /** JMAP account id of the login's primary account. */
  accountId: string;
  username: string;
  /** The persona's own address in this account, used as From on new mail. */
  self: EmailAddress;
  mailboxes: Mailbox[];
  /** Mailboxes of accounts shared with this login, keyed by their owner. */
  sharedMailboxes: Record<string, { name: string; mailboxes: Mailbox[] }>;
  emails: Email[];
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  calendars: Calendar[];
  calendarEvents: CalendarEvent[];
  calendarTasks: CalendarTask[];
  identities: Identity[];
  sieveScripts: SieveScript[];
  sieveCapabilities: SieveCapabilities;
  sieveContent: Record<string, string>;
  fileNodes: FileNode[];
  vacationResponse: VacationResponse;
  quota: { used: number; total: number };
  /** Ids of drafts that are scheduled to go out, with their send time. */
  scheduled: Array<{ emailId: string; identityId: string; sendAt: string }>;
}

export const DEMO_WORK_ACCOUNT_ID = 'demo-account';
export const DEMO_PERSONAL_ACCOUNT_ID = 'demo-personal';

/** What `getSharedAccounts()` reports for a profile. */
export function demoSharedAccounts(profile: DemoProfile): SharedAccount[] {
  if (profile === 'personal') {
    return [{ id: DEMO_PERSONAL_ACCOUNT_ID, name: 'Personal', isPrimary: true, capabilities: { mail: true, sieve: false, calendars: false, contacts: true, filenode: false } }];
  }
  return [
    { id: DEMO_WORK_ACCOUNT_ID, name: 'Meridian Labs', isPrimary: true, capabilities: { mail: true, sieve: true, calendars: true, contacts: true, filenode: true } },
    { id: SUPPORT_ACCOUNT_ID, name: SUPPORT_ACCOUNT_NAME, isPrimary: false, capabilities: { mail: true, sieve: false, calendars: false, contacts: false, filenode: false } },
  ];
}

/** The folders with the grants Nora gave on them (fixtures/directory.ts). */
function withShares(mailboxes: Mailbox[], shares: Record<string, Mailbox['shareWith']>): Mailbox[] {
  return mailboxes.map((mb) => (shares[mb.id] ? { ...mb, shareWith: shares[mb.id] } : mb));
}

/** Return a fresh deep-cloned copy of all demo data for one profile. */
export function getDemoData(profile: DemoProfile = 'work'): DemoData {
  if (profile === 'personal') {
    return cloneFixtures({
      profile,
      accountId: DEMO_PERSONAL_ACCOUNT_ID,
      username: NORA_PERSONAL.email,
      self: { name: NORA_PERSONAL.name, email: NORA_PERSONAL.email },
      mailboxes: createDemoPersonalMailboxes(),
      sharedMailboxes: {},
      emails: createDemoPersonalEmails(),
      contacts: createDemoPersonalContacts(),
      addressBooks: createDemoPersonalAddressBooks(),
      calendars: [],
      calendarEvents: [],
      calendarTasks: [],
      identities: createDemoPersonalIdentities(),
      sieveScripts: [],
      sieveCapabilities: createDemoSieveCapabilities(),
      sieveContent: {},
      fileNodes: [],
      vacationResponse: { id: 'singleton', isEnabled: false, fromDate: null, toDate: null, subject: '', textBody: '', htmlBody: null },
      quota: { used: 1_814_000_000, total: 10_737_418_240 },
      scheduled: [],
    });
  }
  const scheduledAt = new Date();
  scheduledAt.setHours(12, 0, 0, 0);
  if (scheduledAt.getTime() < Date.now()) scheduledAt.setDate(scheduledAt.getDate() + 1);
  return cloneFixtures({
    profile,
    accountId: DEMO_WORK_ACCOUNT_ID,
    username: NORA.email,
    self: { name: NORA.name, email: NORA.email },
    mailboxes: withShares(createDemoMailboxes(), createDemoMailboxShares()),
    sharedMailboxes: { [SUPPORT_ACCOUNT_ID]: { name: SUPPORT_ACCOUNT_NAME, mailboxes: createDemoSupportMailboxes() } },
    emails: [...createDemoEmails(), ...createDemoSignedEmails(), ...createDemoSupplierEmails(), ...createDemoTravelEmails(), ...createDemoSupportEmails()],
    contacts: createDemoContacts(),
    addressBooks: createDemoAddressBooks(),
    calendars: createDemoCalendars(),
    calendarEvents: createDemoCalendarEvents(),
    calendarTasks: createDemoCalendarTasks(),
    identities: createDemoIdentities(),
    sieveScripts: createDemoSieveScripts(),
    sieveCapabilities: createDemoSieveCapabilities(),
    sieveContent: createDemoSieveContent(),
    fileNodes: createDemoFileNodes(),
    vacationResponse: createDemoVacationResponse(),
    quota: { used: 6_442_450_944, total: 21_474_836_480 },
    scheduled: [{ emailId: 'demo-email-scheduled-prep', identityId: 'demo-identity-primary', sendAt: scheduledAt.toISOString() }],
  });
}
