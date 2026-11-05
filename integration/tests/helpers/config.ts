/**
 * Shared configuration for the integration tests. Values mirror the Stalwart
 * bootstrap (integration/stalwart/*) and the docker-compose port mappings.
 * Everything is overridable via env so the suite can run against a differently
 * mapped stack (e.g. remote CI) without code changes.
 */

export const DOMAIN = process.env.IT_DOMAIN ?? 'example.org';

/** Shared password for every test mailbox (TEST_ACCOUNT_PASSWORD in .env). */
export const ACCOUNT_PASSWORD = process.env.IT_ACCOUNT_PASSWORD ?? 'test-pass-123';

/** Webmail app origin (containerised, published on the host). */
export const WEBMAIL_URL = process.env.IT_WEBMAIL_URL ?? 'http://localhost:3000';

/** Stalwart JMAP + admin base URL (host-published). */
export const JMAP_URL = process.env.IT_JMAP_URL ?? 'http://localhost:8025';

/** Stalwart SMTP submission listener (host-published, maps to container 587). */
export const SMTP_HOST = process.env.IT_SMTP_HOST ?? 'localhost';
export const SMTP_PORT = Number(process.env.IT_SMTP_PORT ?? 1025);

/**
 * `jmap-import` = put each "sent" message straight into the recipients' Inboxes
 * with JMAP Email/import instead of SMTP, for a server whose submission port
 * can't be reached from the test machine, such as the shared test servers
 * (inbound port 25 files unauthenticated mail from the local domain as junk).
 * Only works for recipients among ACCOUNTS, which share ACCOUNT_PASSWORD.
 */
export const SMTP_MODE = process.env.IT_SMTP_MODE ?? 'smtp';

/** Recovery admin — `user:password`, used for stalwart-cli style admin JMAP. */
export const ADMIN_CREDENTIALS = process.env.IT_ADMIN ?? 'admin:bootstrap-secret';

export interface TestAccount {
  /** Local part, e.g. "alice". */
  user: string;
  /** Full address, e.g. "alice@example.org". */
  email: string;
  password: string;
}

function acct(user: string): TestAccount {
  return { user, email: `${user}@${DOMAIN}`, password: ACCOUNT_PASSWORD };
}

/**
 * The mailboxes provisioned by the Stalwart bootstrap plan. IT_ACCOUNT_USERS
 * renames the three local parts (in this order) for a stack with other users,
 * such as the shared test servers.
 */
const USERS = (process.env.IT_ACCOUNT_USERS ?? 'alice,bob,carol').split(',');
export const ACCOUNTS = {
  alice: acct(USERS[0]),
  bob: acct(USERS[1]),
  carol: acct(USERS[2]),
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

/**
 * The shared *group* account provisioned by the bootstrap (a Stalwart Group
 * principal, not a login). `carol` is made a member before her first login, so
 * she sees the group's folders under "Shared" and can send as its address.
 * Groups have no password of their own — access is via a member's session.
 * (carol, rather than alice/bob, keeps the sync specs' accounts unshared.)
 */
/** Local part of the group: IT_GROUP_USER for a stack with other names. */
const GROUP_USER = process.env.IT_GROUP_USER ?? 'team';
export const GROUP = {
  team: { user: GROUP_USER, email: `${GROUP_USER}@${DOMAIN}`, memberOf: 'carol' as AccountKey },
} as const;
