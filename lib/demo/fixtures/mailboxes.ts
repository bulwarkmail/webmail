import type { Mailbox } from '@/lib/jmap/types';

const RIGHTS_SYSTEM = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: false, mayDelete: false, maySubmit: true };
const RIGHTS_CUSTOM = { ...RIGHTS_SYSTEM, mayRename: true, mayDelete: true };

// Counts are left at zero here; DemoJMAPClient recomputes them from the mail
// when it starts, so they can never drift from the fixtures.
const COUNTS = { totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 };

const system = (id: string, name: string, role: string, sortOrder: number, parentId?: string): Mailbox =>
  ({ id, name, role, sortOrder, ...COUNTS, myRights: RIGHTS_SYSTEM, isSubscribed: true, ...(parentId ? { parentId } : {}) });
const custom = (id: string, name: string, sortOrder: number, parentId?: string): Mailbox =>
  ({ id, name, sortOrder, ...COUNTS, myRights: RIGHTS_CUSTOM, isSubscribed: true, ...(parentId ? { parentId } : {}) });

// ── Work account (the primary login) ─────────────────────────
export const MB = {
  inbox: 'demo-mailbox-inbox',
  drafts: 'demo-mailbox-drafts',
  sent: 'demo-mailbox-sent',
  archive: 'demo-mailbox-archive',
  archive2025: 'demo-mailbox-archive-2025',
  archive2024: 'demo-mailbox-archive-2024',
  junk: 'demo-mailbox-junk',
  trash: 'demo-mailbox-trash',
  projects: 'demo-mailbox-projects',
  beacon: 'demo-mailbox-projects-beacon',
  website: 'demo-mailbox-projects-website',
  receipts: 'demo-mailbox-receipts',
  travel: 'demo-mailbox-travel',
  newsletters: 'demo-mailbox-newsletters',
} as const;

export function createDemoMailboxes(): Mailbox[] {
  return [
    system(MB.inbox, 'Inbox', 'inbox', 1),
    system(MB.drafts, 'Drafts', 'drafts', 2),
    system(MB.sent, 'Sent', 'sent', 3),
    system(MB.archive, 'Archive', 'archive', 4),
    custom(MB.archive2025, '2025', 1, MB.archive),
    custom(MB.archive2024, '2024', 2, MB.archive),
    system(MB.junk, 'Spam', 'junk', 5),
    system(MB.trash, 'Trash', 'trash', 6),
    custom(MB.projects, 'Projects', 10),
    custom(MB.beacon, 'Beacon', 1, MB.projects),
    custom(MB.website, 'Website redesign', 2, MB.projects),
    custom(MB.receipts, 'Receipts', 11),
    custom(MB.travel, 'Travel', 12),
    custom(MB.newsletters, 'Newsletters', 13),
  ];
}

// ── Shared Support mailbox (delegated to the work login) ─────
// Bare ids as the owner account holds them; the client namespaces them
// `demo-support:<id>` when it lists them next to the user's own folders.
export const SUPPORT_ACCOUNT_ID = 'demo-support';
export const SUPPORT_ACCOUNT_NAME = 'Support';
export const SMB = {
  inbox: 'demo-support-inbox',
  sent: 'demo-support-sent',
  resolved: 'demo-support-resolved',
  // Where the team's notes live (fixtures/team-notes.ts); Bulwark never lists it.
  notes: 'demo-support-team-notes',
} as const;

export function createDemoSupportMailboxes(): Mailbox[] {
  return [
    system(SMB.inbox, 'Inbox', 'inbox', 1),
    system(SMB.sent, 'Sent', 'sent', 2),
    custom(SMB.resolved, 'Resolved', 10),
    { ...custom(SMB.notes, 'Team notes', 90), isSubscribed: false },
  ];
}

// ── Personal account (the second login) ──────────────────────
export const PMB = {
  inbox: 'demo-personal-inbox',
  drafts: 'demo-personal-drafts',
  sent: 'demo-personal-sent',
  archive: 'demo-personal-archive',
  junk: 'demo-personal-junk',
  trash: 'demo-personal-trash',
  family: 'demo-personal-family',
} as const;

export function createDemoPersonalMailboxes(): Mailbox[] {
  return [
    system(PMB.inbox, 'Inbox', 'inbox', 1),
    system(PMB.drafts, 'Drafts', 'drafts', 2),
    system(PMB.sent, 'Sent', 'sent', 3),
    system(PMB.archive, 'Archive', 'archive', 4),
    system(PMB.junk, 'Spam', 'junk', 5),
    system(PMB.trash, 'Trash', 'trash', 6),
    custom(PMB.family, 'Family', 10),
  ];
}
