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

/** The mailboxes provisioned by the Stalwart bootstrap plan. */
export const ACCOUNTS = {
  alice: acct('alice'),
  bob: acct('bob'),
  carol: acct('carol'),
} as const;

export type AccountKey = keyof typeof ACCOUNTS;
