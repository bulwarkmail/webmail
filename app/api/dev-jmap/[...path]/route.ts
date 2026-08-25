import { NextRequest, NextResponse } from 'next/server';
import { pointerTokenValue } from '@/lib/jmap/patch-pointer';

/**
 * Mock JMAP server for local development.
 *
 * Enabled only when DEV_MOCK_JMAP=true. Provides realistic dummy data
 * so the UI can be developed without a real JMAP mail server.
 *
 * Accepts any username/password - no real authentication.
 */

const ACCOUNT_ID = 'dev-account-001';
const scheduledSubmissions: Array<{ id: string; emailId: string; identityId: string; sendAt: string; undoStatus: 'pending' | 'final' | 'canceled' }> = [];
const emailCreationIds = new Map<string, string>();
const DEFAULT_PUSH_RELAY_ORIGIN = 'https://notifications.relay.bulwarkmail.org';

interface MockPushSubscription {
  id: string;
  deviceClientId: string;
  expires: string | null;
  types: string[] | null;
  expectedVerificationCode: string;
  verified: boolean;
}

const pushSubscriptions: MockPushSubscription[] = [];

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

interface MockMailbox {
  id: string;
  name: string;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
}

interface MockEmail {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  subject: string;
  preview: string;
  hasAttachment: boolean;
  textBody: { partId: string; blobId: string; size: number; type: string }[];
  htmlBody: { partId: string; blobId: string; size: number; type: string }[];
  bodyValues: Record<string, { value: string }>;
  attachments?: { partId: string; blobId: string; size: number; name: string; type: string }[];
}

let stateCounter = 1;
function nextState(): string {
  return `mock-state-${++stateCounter}`;
}

const mailboxes: MockMailbox[] = [
  { id: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 1, totalEmails: 5, unreadEmails: 2 },
  { id: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 2, totalEmails: 1, unreadEmails: 0 },
  { id: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 3, totalEmails: 3, unreadEmails: 0 },
  { id: 'mb-junk', name: 'Junk', role: 'junk', sortOrder: 4, totalEmails: 1, unreadEmails: 1 },
  { id: 'mb-trash', name: 'Trash', role: 'trash', sortOrder: 5, totalEmails: 0, unreadEmails: 0 },
  { id: 'mb-archive', name: 'Archive', role: 'archive', sortOrder: 6, totalEmails: 2, unreadEmails: 0 },
];

function recomputeMailboxCounts(): void {
  for (const mb of mailboxes) {
    mb.totalEmails = emails.filter((e) => e.mailboxIds[mb.id]).length;
    mb.unreadEmails = emails.filter((e) => e.mailboxIds[mb.id] && !e.keywords.$seen).length;
  }
}

// ---------------------------------------------------------------------------
// Email fixtures
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(n: number): string {
  const d = new Date();
  d.setTime(d.getTime() - n * 3600000);
  return d.toISOString();
}

/** Return an ISO date-time string for a day offset (0 = today) at a given hour:minute. */
function localDateTime(dayOffset: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().replace(/Z$/, '');
}

/** Parse a JMAP duration like "PT1H30M", "P1D", "PT45M" into milliseconds. */
function _parseDurationMs(dur: string): number {
  let ms = 0;
  const dayMatch = dur.match(/(\d+)D/);
  const hourMatch = dur.match(/(\d+)H/);
  const minMatch = dur.match(/(\d+)M/);
  if (dayMatch) ms += parseInt(dayMatch[1]) * 86400000;
  if (hourMatch) ms += parseInt(hourMatch[1]) * 3600000;
  if (minMatch) ms += parseInt(minMatch[1]) * 60000;
  return ms;
}

const emails: MockEmail[] = [
  // =====================================================================
  // INBOX
  // =====================================================================
  {
    id: 'email-001', threadId: 'thread-001', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 4200, receivedAt: daysAgo(0),
    from: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Willkommen bei Bulwark Webmail!',
    preview: 'Hallo! Welcome to Bulwark - a modern, open-source webmail client for Stalwart Mail Server, built fresh on JMAP.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-001', size: 2200, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hallo!\n\nWelcome to Bulwark - a modern, open-source webmail client for Stalwart Mail Server, built fresh on the JMAP protocol. No PHP, no 2008 architecture, no plugin-of-plugins archaeology; just clean TypeScript and Next.js, instant push, and a UI that feels like a native app instead of a Gmail polyfill.\n\nWhy JMAP matters: one TLS connection instead of long-polling, push notifications the moment new mail arrives, batched mutations so a click never waits on three round-trips, and threading stitched on the server rather than reassembled in the browser. The result is a webmail that feels quick on a flaky train Wi-Fi and quicker on fibre.\n\nMail, calendar, contacts, and files - everything Stalwart already serves, surfaced through a single window. Threaded inbox with full-text search and Sieve filters. Month, week, day and agenda views with recurring events and iMIP invitations. Multiple address books with vCard import and export. File previews backed by Stalwart\'s JMAP FileNode storage. S/MIME, templates, keyboard shortcuts, dark mode, dozens of languages - the boring stuff that should just work, working.\n\nTwo containers behind your reverse proxy of choice is all it takes to host it yourself: Stalwart for the server side, Bulwark for the client. Caddy, Traefik, nginx - pick one, there are working examples for each. Stalwart stays the source of truth, Bulwark is what you point your browser at, and the setup wizard handles the parts that would otherwise live in a config file.\n\nIt is AGPL, the codebase is small enough to read in an afternoon, and the extension directory already hosts a growing collection of plugins and themes. If something is missing, you can fork it, file an issue, or send a patch - a person will read it.\n\nBeste Grüße,\nSophie' },
    },
  },
  {
    id: 'email-002', threadId: 'thread-002', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$label:work/clients/acme': true }, size: 5100, receivedAt: daysAgo(1),
    from: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Karel de Vries', email: 'karel@devries.example' }],
    subject: 'Q1 numbers, and the part I want to talk about',
    preview: 'The deck is attached. Short version: we land on target, but not the way we planned it.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-003', size: 780, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-004', size: 1600, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hello both,\n\nThe deck is attached. Short version: we land on target, but not the way we planned it.\n\nRevenue: +12% against a +9% forecast. Almost all of it comes from the two enterprise renewals in February, so it is two customers, not a trend.\n\nSignups: +8%, which is under plan. The self-serve funnel loses people at the payment step, and it has done so for three quarters now.\n\nSupport satisfaction: 94% across 1.240 tickets.\n\nI would like twenty minutes on Thursday for the funnel drop-off before we commit to Q2 targets. The rest of the deck can be read offline.\n\nBien à vous,\nPierre' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;"><p>Hello both,</p><p>The deck is attached. Short version: we land on target, but not the way we planned it.</p><table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;margin:18px 0;"><tr><td style="padding:7px 24px 7px 0;border-bottom:1px solid #e6e6e6;color:#57606a;">Revenue</td><td style="padding:7px 0;border-bottom:1px solid #e6e6e6;text-align:right;font-variant-numeric:tabular-nums;">+12%</td><td style="padding:7px 0 7px 18px;border-bottom:1px solid #e6e6e6;color:#57606a;">forecast +9%</td></tr><tr><td style="padding:7px 24px 7px 0;border-bottom:1px solid #e6e6e6;color:#57606a;">New signups</td><td style="padding:7px 0;border-bottom:1px solid #e6e6e6;text-align:right;font-variant-numeric:tabular-nums;">+8%</td><td style="padding:7px 0 7px 18px;border-bottom:1px solid #e6e6e6;color:#57606a;">forecast +15%</td></tr><tr><td style="padding:7px 24px 7px 0;color:#57606a;">Support satisfaction</td><td style="padding:7px 0;text-align:right;font-variant-numeric:tabular-nums;">94%</td><td style="padding:7px 0 7px 18px;color:#57606a;">1.240 tickets</td></tr></table><p>The revenue line is two enterprise renewals in February, so it is two customers, not a trend. The funnel loses people at the payment step and has done so for three quarters now.</p><p>I would like twenty minutes on Thursday for the drop-off before we commit to Q2 targets. The rest of the deck can be read offline.</p><p>Bien à vous,<br>Pierre</p></div>' },
    },
    attachments: [
      { partId: 'att1', blobId: 'blob-att-001', size: 24500, name: 'Q1-Bericht.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-003', threadId: 'thread-003', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2400, receivedAt: daysAgo(2),
    from: [{ name: 'Chiara Rossi', email: 'chiara@rossi.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Lunch tomorrow?',
    preview: 'Are you free around 12:30? There is a new place on the Herengracht that does a decent risotto.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-005', size: 240, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-006', size: 320, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Are you free around 12:30? There is a new place on the Herengracht that does a decent risotto, which is a low bar in this city, but they clear it.\n\nI have a call at 14:00, so it has to be a short one.\n\nChiara' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;"><p>Are you free around 12:30? There is a new place on the Herengracht that does a decent risotto, which is a low bar in this city, but they clear it.</p><p>I have a call at 14:00, so it has to be a short one.</p><p>Chiara</p></div>' },
    },
  },
  {
    id: 'email-004', threadId: 'thread-004', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:work/clients': true, '$label:receipts': true }, size: 6200, receivedAt: daysAgo(0),
    from: [{ name: 'GitHub', email: 'notifications@github.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[bulwark-webmail] Theme choice is ignored after an OS theme change (#42)',
    preview: 'karel-devries opened issue #42: setting the theme to Dark explicitly, then switching the OS to light, drops back to the OS theme on reload.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-007', size: 620, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-008', size: 980, type: 'text/html' }],
    bodyValues: {
      p1: { value: '@karel-devries opened issue #42\n\nSteps:\n1. Settings > Appearance > Theme: Dark\n2. Switch the OS to its light theme\n3. Reload the page\n\nExpected: it stays dark, because the choice was explicit.\nActual: it follows the OS again.\n\nThe stored preference survives the reload (I can see it in localStorage), it just is not read before first paint. Firefox 128 on Fedora 41, reproduced in Chromium 133.\n\n-\nReply to this email directly, view it on GitHub, or unsubscribe.' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#24292f;"><p style="margin:0 0 14px 0;"><strong>@karel-devries</strong> opened issue <a href="#" style="color:#0969da;text-decoration:none;">#42</a></p><div style="border-left:3px solid #d0d7de;padding:2px 0 2px 14px;color:#24292f;"><p style="margin:0 0 10px 0;">Steps:</p><ol style="margin:0 0 12px 0;padding-left:20px;"><li>Settings &rsaquo; Appearance &rsaquo; Theme: Dark</li><li>Switch the OS to its light theme</li><li>Reload the page</li></ol><p style="margin:0 0 10px 0;"><strong>Expected:</strong> it stays dark, because the choice was explicit.<br><strong>Actual:</strong> it follows the OS again.</p><p style="margin:0 0 10px 0;">The stored preference survives the reload (I can see it in <code style="background:#f6f8fa;padding:1px 5px;border-radius:3px;font-size:13px;">localStorage</code>), it just is not read before first paint.</p><p style="margin:0;">Firefox 128 on Fedora 41, reproduced in Chromium 133.</p></div><p style="margin:18px 0 0 0;color:#57606a;font-size:12px;border-top:1px solid #eaeef2;padding-top:12px;">Reply to this email directly, <a href="#" style="color:#57606a;">view it on GitHub</a>, or <a href="#" style="color:#57606a;">unsubscribe</a>.</p></div>' },
    },
  },
  {
    id: 'email-005', threadId: 'thread-005', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 3300, receivedAt: daysAgo(4),
    from: [{ name: 'Bram Kuipers', email: 'bram@ietf-lists.example' }],
    to: [{ name: 'jmap', email: 'jmap@ietf-lists.example' }], cc: [],
    subject: 'Re: [jmap] $seen on a shared mailbox: per account or per message?',
    preview: 'Per message. The keyword lives on the Email object and the Email object is shared, so marking it read in one account marks it read in the other.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-009', size: 800, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'On Tue, 24 Mar 2026 at 09:12, Astrid van der Berg wrote:\n> If two accounts have the same mailbox mapped, is $seen per account\n> or per message? We get bug reports either way.\n\nPer message. The keyword lives on the Email object, the Email object is shared, so marking it read in one account marks it read in the other. That is the reading most servers implement.\n\nIf you want per-account state you need per-account Email objects, which is what delegated mailboxes usually end up with anyway. RFC 8621 is quiet about the shared case, which is why your bug reports go both ways.\n\nWorth writing down in the interop notes before someone standardises the wrong half of it.\n\nBram\n--\njmap mailing list -- jmap@ietf-lists.example\nTo unsubscribe send an email to jmap-leave@ietf-lists.example' },
    },
  },
  // Newsletter with a full HTML body
  {
    id: 'email-013', threadId: 'thread-012', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:personal/finance': true }, size: 18200, receivedAt: daysAgo(0),
    from: [{ name: 'Sidenote', email: 'post@sidenote.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Sidenote 47: the Component Model shipped and nobody has to care yet',
    preview: 'Wasm components reached 1.0 last week. The spec is done, the toolchain is not, and that gap is the whole story.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-020', size: 1900, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-021', size: 9400, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'SIDENOTE 47\nA weekly letter about the web, from Berlin\n\n---\n\nTHE COMPONENT MODEL SHIPPED AND NOBODY HAS TO CARE YET\n\nWasm components reached 1.0 last week. The spec is done, the toolchain is not, and that gap is the whole story.\n\nWhat you get today: a Rust crate and a JS host that can pass a record across the boundary without hand-writing glue. What you do not get: a debugger that survives the boundary, or a bundler that treats a component as a first-class input. If you are shipping a WASM module today you will keep hand-writing the glue for another year, and that is fine.\n\nThe part that matters long term is the interface types, not the packaging. Once two languages agree on what a string is, the argument moves somewhere more interesting.\n\n---\n\nCOOKIE BANNERS ARE STILL LEGAL THEATRE\n\nEvery serious analytics tool now measures without setting an identifier: aggregate at the edge, drop the raw log, and answer at the level of a page and a day instead of a person.\n\nWe ran Plausible, Umami and a self-hosted Matomo against the same fortnight of traffic. Session counts landed within 4% of each other. Where they differ is what they cannot tell you: none of them will follow a visitor across two weeks, which is the point.\n\nIf your dashboard has a funnel with six steps and a cohort retention chart, you are still identifying people. Say so in the privacy notice and stop pretending the banner covers it.\n\n---\n\nFIVE LINKS\n\n1. A write-up of a Postgres index that got slower after ANALYZE, with the plan output.\n2. The CSS working group minutes on anchor positioning. Short, and it settles the popover argument.\n3. Someone rewrote git bisect as a 90-line shell script. Useful mainly as a reading exercise.\n4. Notes from a team that moved 40 services off Kubernetes and back onto three machines.\n5. A tiny font renderer in 500 lines of C. The hinting section is worth the read on its own.\n\n---\n\nSidenote UG, Torstraße 12, 10119 Berlin\nYou get this because you signed up at sidenote.example.\nUnsubscribe: sidenote.example/unsubscribe' },
      p2: { value: `<div style="margin:0;padding:36px 16px;background:#f2efe8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#fffdf9;">
  <tr><td style="padding:34px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.02em;color:#20242a;">Sidenote</td>
      <td align="right" style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#a09880;">No. 47 &middot; 26 March</td>
    </tr></table>
    <p style="margin:8px 0 0 0;font-size:13px;color:#8d8674;">A weekly letter about the web, from Berlin</p>
  </td></tr>
  <tr><td style="padding:26px 40px 0 40px;"><div style="border-top:2px solid #20242a;"></div></td></tr>

  <tr><td style="padding:26px 40px 0 40px;">
    <h2 style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:1.25;font-weight:400;color:#20242a;">The Component Model shipped and nobody has to care yet</h2>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#3c414a;">Wasm components reached 1.0 last week. The spec is done, the toolchain is not, and that gap is the whole story.</p>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#3c414a;">What you get today is a Rust crate and a JS host that can pass a record across the boundary without hand-written glue. What you do not get is a debugger that survives that boundary, or a bundler that treats a component as a first-class input. If you ship a WASM module this year, you will keep writing the glue by hand, and that is a reasonable place to be.</p>
    <p style="margin:0 0 18px 0;font-size:15px;line-height:1.7;color:#3c414a;">The durable part is the interface types, not the packaging. Once two languages agree on what a string is, the argument moves somewhere more interesting.</p>
    <a href="#" style="font-size:14px;font-weight:600;color:#a03e21;text-decoration:none;border-bottom:1px solid #e0c8bd;padding-bottom:2px;">Read the full piece</a>
  </td></tr>

  <tr><td style="padding:30px 40px 0 40px;"><div style="border-top:1px solid #e6e0d2;"></div></td></tr>

  <tr><td style="padding:26px 40px 0 40px;">
    <h2 style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:1.25;font-weight:400;color:#20242a;">Cookie banners are still legal theatre</h2>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#3c414a;">Every serious analytics tool now measures without setting an identifier: aggregate at the edge, drop the raw log, answer at the level of a page and a day instead of a person.</p>
    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:#3c414a;">We pointed three of them at the same fortnight of traffic.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;margin:0 0 16px 0;">
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e6e0d2;color:#8d8674;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">Tool</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #e6e0d2;color:#8d8674;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">Sessions</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #e6e0d2;color:#8d8674;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">Delta</td>
      </tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f0ece1;color:#3c414a;">Plausible</td><td align="right" style="padding:9px 0;border-bottom:1px solid #f0ece1;font-variant-numeric:tabular-nums;color:#20242a;">41.208</td><td align="right" style="padding:9px 0;border-bottom:1px solid #f0ece1;color:#8d8674;">&mdash;</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f0ece1;color:#3c414a;">Umami</td><td align="right" style="padding:9px 0;border-bottom:1px solid #f0ece1;font-variant-numeric:tabular-nums;color:#20242a;">40.114</td><td align="right" style="padding:9px 0;border-bottom:1px solid #f0ece1;color:#8d8674;">&minus;2,7%</td></tr>
      <tr><td style="padding:9px 0;color:#3c414a;">Matomo (self-hosted)</td><td align="right" style="padding:9px 0;font-variant-numeric:tabular-nums;color:#20242a;">42.760</td><td align="right" style="padding:9px 0;color:#8d8674;">+3,8%</td></tr>
    </table>
    <p style="margin:0;font-size:15px;line-height:1.7;color:#3c414a;">Where they agree is the count. Where they differ is what they refuse to do: none of them will follow a visitor across two weeks. If your dashboard has a six-step funnel and a cohort retention chart, you are identifying people. Put that in the privacy notice and stop asking the banner to carry it.</p>
  </td></tr>

  <tr><td style="padding:30px 40px 0 40px;"><div style="border-top:1px solid #e6e0d2;"></div></td></tr>

  <tr><td style="padding:24px 40px 0 40px;">
    <p style="margin:0 0 14px 0;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#a09880;">Five links</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;color:#3c414a;">
      <tr><td width="26" valign="top" style="padding:0 0 12px 0;font-family:Georgia,serif;color:#a09880;">1</td><td style="padding:0 0 12px 0;"><a href="#" style="color:#20242a;text-decoration:none;border-bottom:1px solid #ddd6c6;">A Postgres index that got slower after ANALYZE</a>, with the plan output.</td></tr>
      <tr><td width="26" valign="top" style="padding:0 0 12px 0;font-family:Georgia,serif;color:#a09880;">2</td><td style="padding:0 0 12px 0;"><a href="#" style="color:#20242a;text-decoration:none;border-bottom:1px solid #ddd6c6;">CSSWG minutes on anchor positioning</a>. Short, and it settles the popover argument.</td></tr>
      <tr><td width="26" valign="top" style="padding:0 0 12px 0;font-family:Georgia,serif;color:#a09880;">3</td><td style="padding:0 0 12px 0;"><a href="#" style="color:#20242a;text-decoration:none;border-bottom:1px solid #ddd6c6;">git bisect in 90 lines of shell</a>. Useful mainly as a reading exercise.</td></tr>
      <tr><td width="26" valign="top" style="padding:0 0 12px 0;font-family:Georgia,serif;color:#a09880;">4</td><td style="padding:0 0 12px 0;"><a href="#" style="color:#20242a;text-decoration:none;border-bottom:1px solid #ddd6c6;">Forty services off Kubernetes, onto three machines</a>, with the bill before and after.</td></tr>
      <tr><td width="26" valign="top" style="padding:0;font-family:Georgia,serif;color:#a09880;">5</td><td style="padding:0;"><a href="#" style="color:#20242a;text-decoration:none;border-bottom:1px solid #ddd6c6;">A font renderer in 500 lines of C</a>. The hinting section earns the read on its own.</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:30px 40px 34px 40px;">
    <div style="border-top:1px solid #e6e0d2;padding-top:18px;font-size:12px;line-height:1.75;color:#948d7c;">
      Sidenote UG, Torstraße 12, 10119 Berlin<br>
      You get this because you signed up at sidenote.example.
      <a href="#" style="color:#948d7c;">Unsubscribe</a> &middot; <a href="#" style="color:#948d7c;">Read in the browser</a>
    </div>
  </td></tr>
</table>
</td></tr></table></div>` },
    },
  },
  // --- Additional inbox emails ---
  {
    id: 'email-014', threadId: 'thread-013', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3400, receivedAt: hoursAgo(2),
    from: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Sprint priorities for next week',
    preview: 'Five items, in order. If something here is wrong, say so before the meeting rather than in it.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-030', size: 620, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-031', size: 820, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hej,\n\nFive items for next sprint, in order:\n\n1. Calendar: finish CalendarEvent/set so editing one occurrence stops dropping the other overrides\n2. Threading bug #187: messages with a rewritten Message-ID land in a thread of their own\n3. Contact groups: create, rename, membership\n4. Large mailboxes: the list view still fetches full Email objects to render a preview line\n5. Accessibility follow-ups, focus order in the composer first\n\nPlanning is tomorrow at 10:00 in room A. If something here is wrong, say so before the meeting rather than in it.\n\nLars' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;"><p>Hej,</p><p>Five items for next sprint, in order:</p><ol style="padding-left:20px;"><li style="margin-bottom:6px;"><strong>Calendar:</strong> finish <code style="background:#f6f8fa;padding:1px 5px;border-radius:3px;font-size:13px;">CalendarEvent/set</code> so editing one occurrence stops dropping the other overrides</li><li style="margin-bottom:6px;"><strong>Threading bug #187:</strong> messages with a rewritten Message-ID land in a thread of their own</li><li style="margin-bottom:6px;"><strong>Contact groups:</strong> create, rename, membership</li><li style="margin-bottom:6px;"><strong>Large mailboxes:</strong> the list view still fetches full Email objects to render a preview line</li><li>Accessibility follow-ups, focus order in the composer first</li></ol><p>Planning is tomorrow at 10:00 in room A. If something here is wrong, say so before the meeting rather than in it.</p><p>Lars</p></div>' },
    },
  },
  {
    id: 'email-015', threadId: 'thread-014', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 9800, receivedAt: hoursAgo(5),
    from: [{ name: 'Lago Stays', email: 'reservations@lagostays.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Booking confirmed: Villa sul Lago, Bellagio (28–30 March)',
    preview: 'Reservation LS-4419-BG is confirmed. Check-in Saturday 28 March from 15:00, check-out Monday 30 March by 11:00.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-032', size: 700, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-033', size: 5200, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Reservation LS-4419-BG is confirmed.\n\nVilla sul Lago, Via Roma 8, 22021 Bellagio (CO), Italy\n\nCheck-in: Saturday 28 March, from 15:00\nCheck-out: Monday 30 March, by 11:00\nGuests: 2\n\n2 nights x €175,00 ... €350,00\nCleaning fee ......... €25,00\nTassa di soggiorno ... €10,00\nTotal ................ €385,00\n\nPaid in full. Free cancellation until 21 March, 23:59 CET.\n\nThe key box code is in the attached voucher. Parking is behind the building, the gate remote is on the kitchen table.\n\nMarco, your host, reads messages between 08:00 and 21:00: +39 031 950 118.' },
      p2: { value: `<div style="margin:0;padding:32px 16px;background:#eef1ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="width:580px;max-width:100%;background:#ffffff;">
  <tr><td style="padding:26px 34px;border-bottom:1px solid #e7e9e6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-size:15px;font-weight:700;letter-spacing:0.04em;color:#2c4a3e;">LAGO STAYS</td>
      <td align="right" style="font-size:12px;color:#7d8a83;">Reservation LS-4419-BG</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:30px 34px 0 34px;">
    <p style="margin:0 0 6px 0;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#5b8c76;">Confirmed</p>
    <h1 style="margin:0 0 6px 0;font-size:24px;line-height:1.3;font-weight:600;color:#1d2b25;">Villa sul Lago</h1>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#66736c;">Via Roma 8, 22021 Bellagio (CO), Italy</p>
  </td></tr>

  <tr><td style="padding:24px 34px 0 34px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e7e3;">
      <tr>
        <td width="50%" style="padding:16px 20px;border-right:1px solid #e2e7e3;">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8b9992;">Check-in</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#1d2b25;">Sat 28 March</p>
          <p style="margin:2px 0 0 0;font-size:13px;color:#66736c;">from 15:00</p>
        </td>
        <td width="50%" style="padding:16px 20px;">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8b9992;">Check-out</p>
          <p style="margin:0;font-size:16px;font-weight:600;color:#1d2b25;">Mon 30 March</p>
          <p style="margin:2px 0 0 0;font-size:13px;color:#66736c;">by 11:00</p>
        </td>
      </tr>
      <tr><td colspan="2" style="padding:14px 20px;border-top:1px solid #e2e7e3;font-size:13px;color:#66736c;">2 guests &middot; 2 nights &middot; whole apartment, first floor</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:24px 34px 0 34px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;border-bottom:1px solid #eef0ee;color:#4b5751;">2 nights &times; €175,00</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eef0ee;font-variant-numeric:tabular-nums;color:#1d2b25;">€350,00</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eef0ee;color:#4b5751;">Cleaning fee</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eef0ee;font-variant-numeric:tabular-nums;color:#1d2b25;">€25,00</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eef0ee;color:#4b5751;">Tassa di soggiorno (2 &times; €2,50 per night)</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eef0ee;font-variant-numeric:tabular-nums;color:#1d2b25;">€10,00</td></tr>
      <tr><td style="padding:12px 0;font-weight:600;color:#1d2b25;">Total, paid in full</td><td align="right" style="padding:12px 0;font-weight:600;font-size:16px;font-variant-numeric:tabular-nums;color:#1d2b25;">€385,00</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:8px 34px 0 34px;">
    <div style="background:#f4f7f4;padding:16px 20px;font-size:14px;line-height:1.65;color:#3f4b45;">
      The key box code is in the attached voucher. Parking is behind the building; the gate remote is on the kitchen table.
    </div>
  </td></tr>

  <tr><td style="padding:22px 34px 30px 34px;font-size:14px;line-height:1.7;color:#4b5751;">
    Free cancellation until 21 March, 23:59 CET.<br>
    Marco, your host, reads messages between 08:00 and 21:00: <a href="#" style="color:#2c4a3e;">+39 031 950 118</a>.
  </td></tr>

  <tr><td style="padding:16px 34px 22px 34px;border-top:1px solid #e7e9e6;font-size:12px;line-height:1.7;color:#8b9992;">
    Lago Stays S.r.l., Via Statale 42, 22021 Bellagio (CO) &middot; P.IVA IT03948210131<br>
    <a href="#" style="color:#8b9992;">Manage this booking</a> &middot; <a href="#" style="color:#8b9992;">Invoice</a>
  </td></tr>
</table>
</td></tr></table></div>` },
    },
    attachments: [
      { partId: 'att2', blobId: 'blob-att-002', size: 18200, name: 'voucher-LS-4419-BG.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-016', threadId: 'thread-015', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:personal': true }, size: 4100, receivedAt: hoursAgo(3),
    from: [{ name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'JMAP-342 is up: vCard import',
    preview: 'Contact import from vCard is ready for review. The part I would like you to look at is the merge UI.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-034', size: 640, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-035', size: 860, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Salut,\n\nJMAP-342 is up: https://github.example/bulwark-webmail/pull/342\n\nWhat is in it: a parser for vCard 3.0 and 4.0, batch import with a progress bar, and duplicate detection that matches on UID first and falls back to the email address.\n\nWhat I would like you to look at: the merge dialogue when a duplicate has conflicting fields. I went with "keep both, mark one primary" and I am not convinced that is the right call. The alternative is a field-by-field picker, which is more clicks but less surprising.\n\nThe 3.0 tests are thin. I will add the line-folding cases before it merges.\n\nÉlise' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;"><p>Salut,</p><p>JMAP-342 is up: <a href="#" style="color:#0969da;text-decoration:none;">bulwark-webmail/pull/342</a></p><p><strong>What is in it:</strong> a parser for vCard 3.0 and 4.0, batch import with a progress bar, and duplicate detection that matches on UID first and falls back to the email address.</p><p><strong>What I would like you to look at:</strong> the merge dialogue when a duplicate has conflicting fields. I went with &ldquo;keep both, mark one primary&rdquo; and I am not convinced that is the right call. The alternative is a field-by-field picker, which is more clicks but less surprising.</p><p>The 3.0 tests are thin. I will add the line-folding cases before it merges.</p><p>Élise</p></div>' },
    },
  },
  {
    id: 'email-017', threadId: 'thread-016', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2900, receivedAt: daysAgo(1),
    from: [{ name: 'GitHub', email: 'noreply@github.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'A new sign-in from Firefox on Linux',
    preview: 'Your account was signed in to from a browser we have not seen before. If this was you, there is nothing to do.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-036', size: 350, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Your account was signed in to from a browser we have not seen before.\n\nBrowser: Firefox 128\nOperating system: Linux (Fedora 41)\nLocation: Amsterdam, Netherlands\nIP address: 145.94.12.208\nWhen: 10 March 2026 at 14:15 CET\n\nIf this was you, there is nothing to do. If it was not, change your password and review your active sessions.\n\nGitHub Security' },
    },
  },
  {
    id: 'email-018', threadId: 'thread-017', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$label:work': true }, size: 8900, receivedAt: daysAgo(1),
    from: [{ name: 'Nordhost GmbH', email: 'rechnung@nordhost.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Invoice NH-2026-0284 for February',
    preview: 'Your February invoice comes to €137,35 including VAT. It will be collected by SEPA direct debit on 12 March.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-037', size: 720, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-070', size: 4600, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Guten Tag,\n\nInvoice NH-2026-0284 covers 1 to 28 February 2026 for customer 4181-2260.\n\nDedicated server AX41 ........ €41,20\nStorage box BX11 ............. €11,30\nManaged PostgreSQL ........... €47,10\nLoad balancer LB11 ........... €7,43\nFloating IPv4 (3) ............ €8,39\n\nNet ......................... €115,42\nVAT 19% ...................... €21,93\nTotal ....................... €137,35\n\nThe amount will be collected from IBAN DE** **** **** **** **60 01 on 12 March 2026, mandate NH-M-77213.\n\nThe PDF is attached and stays available in the console for ten years.\n\nMit freundlichen Grüßen\nNordhost GmbH' },
      p2: { value: `<div style="margin:0;padding:32px 16px;background:#f1f2f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="width:580px;max-width:100%;background:#ffffff;border:1px solid #dfe2e6;">
  <tr><td style="padding:24px 32px;background:#22303f;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-size:15px;font-weight:600;letter-spacing:0.06em;color:#ffffff;">NORDHOST</td>
      <td align="right" style="font-size:12px;color:#9fb0bf;">Invoice NH-2026-0284</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:28px 32px 0 32px;">
    <h1 style="margin:0 0 6px 0;font-size:21px;font-weight:600;color:#1c2733;">February 2026</h1>
    <p style="margin:0;font-size:13px;color:#6b7885;">Billing period 1&ndash;28 February &middot; Customer 4181-2260</p>
  </td></tr>

  <tr><td style="padding:22px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;">
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e3e6ea;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a95a1;">Service</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #e3e6ea;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a95a1;">Net</td>
      </tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #eef0f2;color:#33414f;">Dedicated server AX41</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eef0f2;font-variant-numeric:tabular-nums;color:#1c2733;">€41,20</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #eef0f2;color:#33414f;">Storage box BX11</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eef0f2;font-variant-numeric:tabular-nums;color:#1c2733;">€11,30</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #eef0f2;color:#33414f;">Managed PostgreSQL</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eef0f2;font-variant-numeric:tabular-nums;color:#1c2733;">€47,10</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #eef0f2;color:#33414f;">Load balancer LB11</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eef0f2;font-variant-numeric:tabular-nums;color:#1c2733;">€7,43</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #eef0f2;color:#33414f;">Floating IPv4 &times; 3</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eef0f2;font-variant-numeric:tabular-nums;color:#1c2733;">€8,39</td></tr>
      <tr><td style="padding:10px 0;color:#6b7885;">Net</td><td align="right" style="padding:10px 0;font-variant-numeric:tabular-nums;color:#33414f;">€115,42</td></tr>
      <tr><td style="padding:0 0 10px 0;border-bottom:1px solid #e3e6ea;color:#6b7885;">VAT 19%</td><td align="right" style="padding:0 0 10px 0;border-bottom:1px solid #e3e6ea;font-variant-numeric:tabular-nums;color:#33414f;">€21,93</td></tr>
      <tr><td style="padding:14px 0;font-weight:600;color:#1c2733;">Total</td><td align="right" style="padding:14px 0;font-weight:600;font-size:18px;font-variant-numeric:tabular-nums;color:#1c2733;">€137,35</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:4px 32px 0 32px;">
    <div style="background:#f5f7f9;border-left:3px solid #22303f;padding:14px 18px;font-size:14px;line-height:1.65;color:#33414f;">
      Collected by SEPA direct debit on <strong>12 March 2026</strong> from IBAN DE** **** **** **** **60 01, mandate NH-M-77213. No action needed.
    </div>
  </td></tr>

  <tr><td style="padding:22px 32px 30px 32px;">
    <a href="#" style="display:inline-block;border:1px solid #c9d0d7;color:#22303f;font-size:14px;font-weight:600;text-decoration:none;padding:10px 18px;">Open billing console</a>
  </td></tr>

  <tr><td style="padding:16px 32px 22px 32px;border-top:1px solid #e3e6ea;font-size:11px;line-height:1.75;color:#8a95a1;">
    Nordhost GmbH, Speicherstraße 14, 20457 Hamburg &middot; Amtsgericht Hamburg HRB 118420<br>
    Geschäftsführerin: Ines Kalb &middot; USt-IdNr. DE297441022<br>
    The PDF stays available in the console for ten years.
  </td></tr>
</table>
</td></tr></table></div>` },
    },
    attachments: [
      { partId: 'att3', blobId: 'blob-att-003', size: 32100, name: 'Rechnung-NH-2026-0284.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-019', threadId: 'thread-018', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 3600, receivedAt: daysAgo(2),
    from: [{ name: 'Astrid van der Berg', email: 'astrid@berglabs.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }, { name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }], cc: [],
    subject: 'Notes from the API design review',
    preview: 'Four decisions and three action items. Correct me where I have written down the wrong thing.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-038', size: 780, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-039', size: 1000, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hoi,\n\nNotes from this morning. Correct me where I have written down the wrong thing.\n\nDecisions:\n1. REST for anything a customer touches, described in OpenAPI 3.1. Nobody wanted to hand a partner a proto file.\n2. gRPC between our own services, because the calendar sync is chatty and the payload is ours.\n3. GraphQL only in the dashboard BFF. It stays behind our own login.\n4. Rate limits: 100 requests per minute on free, 1.000 on pro, per token rather than per account.\n\nActions:\n- Dev: OpenAPI draft by Friday\n- Lars: proto repository and CI for it\n- Astrid: redraw the service diagram, the old one has two services that no longer exist\n\nNext review 18 March.\n\nGroeten,\nAstrid' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;"><p>Hoi,</p><p>Notes from this morning. Correct me where I have written down the wrong thing.</p><p style="margin-bottom:6px;"><strong>Decisions</strong></p><ol style="padding-left:20px;margin-top:0;"><li style="margin-bottom:6px;">REST for anything a customer touches, described in OpenAPI 3.1. Nobody wanted to hand a partner a proto file.</li><li style="margin-bottom:6px;">gRPC between our own services, because the calendar sync is chatty and the payload is ours.</li><li style="margin-bottom:6px;">GraphQL only in the dashboard BFF. It stays behind our own login.</li><li>Rate limits: 100 req/min on free, 1.000 on pro, per token rather than per account.</li></ol><p style="margin-bottom:6px;"><strong>Actions</strong></p><ul style="padding-left:20px;margin-top:0;"><li style="margin-bottom:6px;">Dev: OpenAPI draft by Friday</li><li style="margin-bottom:6px;">Lars: proto repository and CI for it</li><li>Astrid: redraw the service diagram, the old one has two services that no longer exist</li></ul><p>Next review 18 March.</p><p>Groeten,<br>Astrid</p></div>' },
    },
  },
  {
    id: 'email-020', threadId: 'thread-019', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 5200, receivedAt: daysAgo(3),
    from: [{ name: 'Jacques Lefèvre', email: 'jacques@lefevre-avocats.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Re: Partnership agreement, three clauses to change',
    preview: 'The draft is workable. Three clauses need to change before you sign anything.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-040', size: 820, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Bonjour,\n\nThe draft is workable. Three clauses need to change before you sign anything.\n\nArticle 4.2, intellectual property. As written, anything created during the partnership belongs to both parties, including work that predates it. Add a sentence that pre-existing IP stays with its owner and name your repositories in an annex.\n\nArticle 7.1, non-compete. Twenty-four months across the whole EU will not hold up in a French court and probably not in a German one either. Twelve months, limited to the two named market segments, survives.\n\nArticle 9.3, liability. A fixed cap of 50.000 euros is generous to them today and ruinous to you in year three. Tie it to the fees paid in the preceding twelve months.\n\nMy comments are in the attached document. I have left the rest alone, it is standard.\n\nCall me before you reply to them.\n\nBien cordialement,\nJacques Lefèvre\nLefèvre & Associés' },
    },
    attachments: [
      { partId: 'att4', blobId: 'blob-att-004', size: 45000, name: 'Contrat-de-Partenariat-annote.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ],
  },
  {
    id: 'email-021', threadId: 'thread-020', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2800, receivedAt: daysAgo(3),
    from: [{ name: 'Katrin Bauer', email: 'katrin.bauer@charite.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }, { name: 'Chiara Rossi', email: 'chiara@rossi.example' }],
    subject: 'Team evening: pick one',
    preview: 'Three options for the team evening on 24 April. Reply with a letter, voting closes Friday.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-041', size: 340, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Three options for the team evening on 24 April. Reply with a letter.\n\nA) Dinner at the Portuguese place near the office. Set menu, they can do vegetarian if we say so in advance.\nB) Boat tour, two hours, with something to drink on board. Cancelled if it rains.\nC) Pasta course, three hours, you eat what you make.\n\nVoting closes Friday. If we tie I will pick the cheapest.\n\nKatrin' },
    },
  },
  {
    id: 'email-022', threadId: 'thread-021', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3200, receivedAt: hoursAgo(1),
    from: [{ name: 'GitHub', email: 'notifications@github.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[vcard-parser] Pull request #89 merged: FBURL property',
    preview: 'Your pull request was merged into main by @maintainer.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-042', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Merged #89 into main.\n\nvcard-parser: add support for the FBURL property\nfeature/fburl -> main, merged by @maintainer\n\n  feat: parse FBURL from vCard 4.0\n  test: FBURL round-trip cases\n  docs: FBURL example in the README\n\nThe release workflow picked it up, 2.4.0 is on the registry.\n\n-\nReply to this email directly, view it on GitHub, or unsubscribe.' },
    },
  },
  {
    id: 'email-023', threadId: 'thread-022', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3800, receivedAt: hoursAgo(4),
    from: [{ name: 'Support', email: 'support@saas-platform.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Ticket #4521 escalated: enterprise account hitting the rate limit',
    preview: 'EuroTech GmbH is on the enterprise plan and still getting 429s. Their bursts go over the limit, their average is well under it.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-043', size: 620, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Ticket #4521 is with engineering now.\n\nCustomer: EuroTech GmbH, enterprise plan\nSymptom: 429 responses during their nightly sync, roughly 03:00 to 03:40 CET\n\nWhat the logs show: their average is 340 requests per minute, well under the 1.000 limit. The bursts hit 2.100 for about ninety seconds while the sync opens every mailbox at once.\n\nThey have asked for 5.000 per minute. I would rather we let them burst than raise the ceiling for everyone, but that is your call.\n\nSLA on this one is four hours and it started at 11:20.\n\nDanke,\nMirjam' },
    },
  },
  {
    id: 'email-024', threadId: 'thread-023', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 7200, receivedAt: daysAgo(5),
    from: [{ name: 'DEV Community', email: 'digest@dev-community.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Most read this week',
    preview: 'Why I moved off React and what it cost, a CLI in Rust without clap, and the state of CSS in 2026.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-044', size: 780, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-045', size: 1300, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Most read this week\n\n1. Why I moved off React and what it cost, by @webdev (342 reactions)\n2. Writing a CLI in Rust without clap, by @rustacean (289)\n3. The state of CSS in 2026, by @cssmaster (256)\n4. Microservices are dead, long live the modular monolith, by @architect (234)\n5. WebAssembly components for people who write JavaScript, by @wasmdev (198)\n\nManage what lands in your inbox: dev-community.example/settings' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#24292f;max-width:560px;"><p style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8a94a0;margin:0 0 14px 0;">Most read this week</p><table cellpadding="0" cellspacing="0" border="0" style="width:100%;font-size:15px;"><tr><td style="padding:0 0 12px 0;"><a href="#" style="color:#24292f;text-decoration:none;font-weight:600;">Why I moved off React and what it cost</a><br><span style="color:#6b7580;font-size:13px;">@webdev &middot; 342 reactions</span></td></tr><tr><td style="padding:0 0 12px 0;"><a href="#" style="color:#24292f;text-decoration:none;font-weight:600;">Writing a CLI in Rust without clap</a><br><span style="color:#6b7580;font-size:13px;">@rustacean &middot; 289 reactions</span></td></tr><tr><td style="padding:0 0 12px 0;"><a href="#" style="color:#24292f;text-decoration:none;font-weight:600;">The state of CSS in 2026</a><br><span style="color:#6b7580;font-size:13px;">@cssmaster &middot; 256 reactions</span></td></tr><tr><td style="padding:0 0 12px 0;"><a href="#" style="color:#24292f;text-decoration:none;font-weight:600;">Microservices are dead, long live the modular monolith</a><br><span style="color:#6b7580;font-size:13px;">@architect &middot; 234 reactions</span></td></tr><tr><td style="padding:0 0 4px 0;"><a href="#" style="color:#24292f;text-decoration:none;font-weight:600;">WebAssembly components for people who write JavaScript</a><br><span style="color:#6b7580;font-size:13px;">@wasmdev &middot; 198 reactions</span></td></tr></table><p style="border-top:1px solid #e6e9ec;margin-top:18px;padding-top:12px;font-size:12px;color:#8a94a0;"><a href="#" style="color:#8a94a0;">Manage what lands in your inbox</a></p></div>' },
    },
  },
  {
    id: 'email-025', threadId: 'thread-024', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$color:work/archived': true }, size: 4100, receivedAt: daysAgo(6),
    from: [{ name: 'Mollie Developers', email: 'developers@mollie.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'API version 2023-10 stops working on 15 April',
    preview: 'Two of your API keys still send version 2023-10. After 15 April those calls return 410.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-046', size: 640, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Two of your API keys still send version 2023-10:\n\n  live_k4m...9tz   last used 2 hours ago\n  test_p1q...44b   last used yesterday\n\nAfter 15 April 2026 those calls return 410 Gone.\n\nWhat changes in 2025-01, for the endpoints you use:\n\n- Payment confirmation is a single call. The separate confirm step is gone.\n- Webhook payloads wrap the object in "data" and add "eventId".\n- The deprecated "metadata_json" parameter has been removed. Use "metadata".\n\nMigration guide: mollie.example/docs/upgrades/2025-01\nTest mode accepts the new version today, so you can switch one key and watch it.\n\nMollie Developer Relations' },
    },
  },
  {
    id: 'email-026', threadId: 'thread-013', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 2400, receivedAt: hoursAgo(1),
    from: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }],
    to: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    cc: [{ name: 'Dev User', email: 'dev@localhost' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Re: Sprint priorities for next week',
    preview: 'The order looks right. Can we add the signature editor? It is half done and it keeps coming back in support tickets.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-047', size: 260, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'The order looks right.\n\nCan we add the signature editor? It is half done and it keeps coming back in support tickets. I can take it, it is two days at most.\n\nAlso: 10:30 instead of 10:00 for planning? I have a call that runs to the hour.\n\nSophie' },
    },
  },
  {
    id: 'email-040', threadId: 'thread-035', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 4500, receivedAt: hoursAgo(0.5),
    from: [{ name: 'Liam Ó Donaill', email: 'liam.odonaill@finanz.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Nils Andersson', email: 'nils@digitaal.example' }],
    subject: 'Q1 budget review, Thursday 14:00',
    preview: 'Bring your actual spend. The forecast column in the sheet is mine, the actuals column is yours and it is empty.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-062', size: 480, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Thursday at 14:00, room B, one hour. Zoom link is in the calendar invitation.\n\nAgenda:\n1. Actuals against forecast\n2. Cloud spend, which is 18% over and I would like to know why before I ask upstairs\n3. Headcount for Q2\n4. Licence renewals, three of them run out in May\n\nBring your actual spend. The forecast column in the attached sheet is mine, the actuals column is yours and it is empty.\n\nLiam' },
    },
    attachments: [
      { partId: 'att9', blobId: 'blob-att-009', size: 54000, name: 'Q1-Budget-Vorlage.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  },
  {
    id: 'email-041', threadId: 'thread-036', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2600, receivedAt: daysAgo(7),
    from: [{ name: 'María García', email: 'maria@garcia-design.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Brand guidelines v2 and what it means for the app',
    preview: 'The guidelines are final. Two changes touch the app: the primary colour and the heading font.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-063', size: 520, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'The guidelines are final. Two changes touch the app:\n\nPrimary colour moves from #6366f1 to #7c3aed. It passes AA on white at 14px, which the old one did not, so the small print in the composer stops being a problem.\n\nHeadings move to Cal Sans, body stays Inter. Only headings, so the change is two font faces, not twelve.\n\nThe icons and the dark mode tokens are in the Figma library, same file, page "App v2". Nothing there is new, I only named the tokens properly so they can be read by a script.\n\nPDF attached. Ask before you improvise a shade, I will say yes to most things.\n\nUn saludo,\nMaría' },
    },
    attachments: [
      { partId: 'att10', blobId: 'blob-att-010', size: 3200000, name: 'Markenrichtlinien-v2.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-042', threadId: 'thread-037', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 1900, receivedAt: daysAgo(8),
    from: [{ name: 'Nils Andersson', email: 'nils@digitaal.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Fika next week?',
    preview: 'Tuesday or Wednesday work for me. There is a place on the Prinsengracht that has finally learned to make a kanelbulle.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-064', size: 180, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Tuesday or Wednesday work for me, after 15:00 either day.\n\nThere is a place on the Prinsengracht that has finally learned to make a kanelbulle. Low bar, met.\n\nNils' },
    },
  },
  {
    id: 'email-039', threadId: 'thread-034', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 6400, receivedAt: hoursAgo(0.25),
    from: [{ name: 'CI', email: 'ci@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '❌ bulwark-webmail #482 failed on main',
    preview: 'Two tests failed in email-sanitization.test.ts. Both of them are about style attributes.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-060', size: 620, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-061', size: 3900, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Build #482 failed on main.\n\nCommit  a3f9c21  fix: sanitize CSS in email bodies\nAuthor  Élise Moreau\nRan     42s on ubuntu-24.04, node 22\n\n247 passed, 2 failed, 0 skipped\n\nFAIL  lib/__tests__/email-sanitization.test.ts\n  x strips javascript: URLs from style attributes\n      expected: <div style="">\n      received: <div style="background:url(javascript:alert(1))">\n  x drops @import inside a nested style tag\n      expected 0 matches for /@import/, got 1\n\nLogs: https://ci.fjord-systems.example/runs/482' },
      p2: { value: `<div style="margin:0;padding:28px 16px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="width:580px;max-width:100%;background:#ffffff;border:1px solid #e1e4e8;">
  <tr><td style="padding:16px 26px;background:#b62324;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-size:15px;font-weight:600;color:#ffffff;">Build #482 failed</td>
      <td align="right" style="font-size:12px;color:#f3c8c8;">main &middot; 42s</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:22px 26px 0 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;line-height:1.7;">
      <tr><td width="90" style="color:#8b949e;">Repository</td><td style="color:#24292f;">bulwark-webmail</td></tr>
      <tr><td style="color:#8b949e;">Commit</td><td style="color:#24292f;"><span style="font-family:'SF Mono',Menlo,Consolas,monospace;">a3f9c21</span> fix: sanitize CSS in email bodies</td></tr>
      <tr><td style="color:#8b949e;">Author</td><td style="color:#24292f;">Élise Moreau</td></tr>
      <tr><td style="color:#8b949e;">Runner</td><td style="color:#24292f;">ubuntu-24.04, node 22</td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:18px 26px 0 26px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;">
      <tr>
        <td style="padding:6px 16px 6px 0;color:#1a7f37;"><strong>247</strong> passed</td>
        <td style="padding:6px 16px 6px 0;color:#b62324;"><strong>2</strong> failed</td>
        <td style="padding:6px 0;color:#8b949e;"><strong>0</strong> skipped</td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:12px 26px 0 26px;">
    <div style="background:#0f1419;color:#d6dbe1;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;line-height:1.75;padding:16px 18px;overflow-x:auto;">
      <span style="color:#8b949e;">FAIL</span> lib/__tests__/email-sanitization.test.ts<br>
      &nbsp;&nbsp;<span style="color:#ff7b72;">&times;</span> strips javascript: URLs from style attributes<br>
      &nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#8b949e;">expected</span> <span style="color:#7ee787;">&lt;div style=""&gt;</span><br>
      &nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#8b949e;">received</span> <span style="color:#ff7b72;">&lt;div style="background:url(javascript:alert(1))"&gt;</span><br>
      &nbsp;&nbsp;<span style="color:#ff7b72;">&times;</span> drops @import inside a nested style tag<br>
      &nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#8b949e;">expected</span> 0 matches for /@import/, <span style="color:#8b949e;">got</span> <span style="color:#ff7b72;">1</span>
    </div>
  </td></tr>

  <tr><td style="padding:20px 26px 26px 26px;">
    <a href="#" style="display:inline-block;background:#24292f;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:9px 18px;">View the run</a>
    <a href="#" style="display:inline-block;margin-left:10px;color:#57606a;font-size:13px;text-decoration:none;padding:9px 0;">Re-run failed tests</a>
  </td></tr>
</table>
</td></tr></table></div>` },
    },
  },
  // =====================================================================
  // SENT
  // =====================================================================
  {
    id: 'email-006', threadId: 'thread-003', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1800, receivedAt: daysAgo(2),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Chiara Rossi', email: 'chiara@rossi.example' }], cc: [],
    subject: 'Re: Lunch tomorrow?',
    preview: '12:30 works. I will be the one already sitting down.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-011', size: 110, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: '12:30 works. I will be the one already sitting down.\n\nIf the risotto is bad we are never speaking of this again.' },
    },
  },
  {
    id: 'email-007', threadId: 'thread-006', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 2200, receivedAt: daysAgo(3),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }], cc: [],
    subject: 'Re: Q1 numbers, and the part I want to talk about',
    preview: 'Twenty minutes is fine. Can you send the funnel numbers per step beforehand?',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-012', size: 210, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Twenty minutes is fine, put it at the front of the call.\n\nCan you send the funnel numbers per step beforehand? If the drop is at payment details I would like to know whether it is the form or the card.\n\nDev' },
    },
  },
  {
    id: 'email-008', threadId: 'thread-007', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 3100, receivedAt: daysAgo(5),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }], cc: [],
    subject: 'Mockup feedback',
    preview: 'Three notes on the new screens, none of them blocking.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-013', size: 380, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Three notes, none of them blocking.\n\nThe sidebar labels sit at about 3:1 against the background. On my laptop outdoors they disappear.\n\nSettings needs a way back out. Breadcrumbs or a title with the section name, either is fine.\n\nThe compose button where it is now is right. I was wrong about that in the last round.\n\nDev' },
    },
  },
  {
    id: 'email-027', threadId: 'thread-013', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1900, receivedAt: hoursAgo(0.5),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    cc: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Re: Sprint priorities for next week',
    preview: '10:30 works. Signature editor goes in as item six, below the accessibility follow-ups.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-048', size: 220, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: '10:30 works, I moved the invitation.\n\nSignature editor goes in as item six, below the accessibility follow-ups. Sophie, if it really is two days, it lands. If it turns into four, it comes back out.\n\nDev' },
    },
  },
  {
    id: 'email-028', threadId: 'thread-015', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 2100, receivedAt: daysAgo(1),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }], cc: [],
    subject: 'Re: JMAP-342 is up: vCard import',
    preview: 'Comments are on the PR. Keep the merge dialogue as it is, but the import needs to stream.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-049', size: 340, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Comments are on the PR.\n\nKeep the merge dialogue as it is. "Keep both, mark one primary" is recoverable, a wrong field pick is not, and people will click through the picker without reading it.\n\nThe import reads the whole file into memory first. At 1.200 contacts my tab used 380 MB. Stream it and I will approve.\n\nDev' },
    },
  },
  {
    id: 'email-029', threadId: 'thread-018', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1600, receivedAt: daysAgo(2),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Astrid van der Berg', email: 'astrid@berglabs.example' }], cc: [],
    subject: 'Re: Notes from the API design review',
    preview: 'One correction: the rate limit is per token, not per key. Draft lands Friday.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-050', size: 190, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'One correction: we said per token, and a customer can hold several. That matters for the enterprise ticket that is open right now.\n\nOpenAPI draft lands Friday.\n\nDev' },
    },
  },
  {
    id: 'email-030', threadId: 'thread-025', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 4800, receivedAt: daysAgo(4),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Team', email: 'team@fjord-systems.example' }], cc: [],
    subject: 'Proposal: move the mail backend to JMAP',
    preview: 'Our REST layer is a worse version of a protocol that already exists. The proposal is to stop maintaining it.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-051', size: 1100, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Our REST layer is a worse version of a protocol that already exists. The proposal is to stop maintaining it and speak JMAP (RFC 8620 and 8621) directly.\n\nWhat we get:\n\n- One request instead of the current fan-out. Opening a 40-message thread costs us 41 calls today.\n- Push over EventSource, so we can delete the polling worker and the Redis key it uses to deduplicate.\n- Delta sync. In the prototype, a warm sync of a 12.000-message mailbox moved 240 KB instead of 3,1 MB.\n\nWhat it costs:\n\n- Two people for roughly ten weeks.\n- A migration path for the three integrations that read our REST endpoints. Two are internal, one is a customer and needs notice.\n\nRough plan: prototype in March against a mock server, core mail in April, calendar and contacts in May, cut over in June with the old endpoints kept read-only until September.\n\nFull write-up attached, including the numbers behind the sync figure.\n\nDev' },
    },
    attachments: [
      { partId: 'att5', blobId: 'blob-att-005', size: 67000, name: 'JMAP-Migration-Proposal.pdf', type: 'application/pdf' },
    ],
  },
  // =====================================================================
  // DRAFTS
  // =====================================================================
  {
    id: 'email-009', threadId: 'thread-008', mailboxIds: { 'mb-drafts': true }, keywords: { $draft: true }, size: 1200, receivedAt: daysAgo(0),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Team', email: 'team@fjord-systems.example' }], cc: [],
    subject: 'Standup notes',
    preview: 'Blocked on the CalendarEvent/set override question...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-014', size: 220, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Yesterday: threading bug, no cause yet\nToday: CalendarEvent/set overrides\nBlocked on: whether we keep the old override when the recurrence rule changes\n\nTODO: ask Lars before sending this' },
    },
  },
  {
    id: 'email-031', threadId: 'thread-026', mailboxIds: { 'mb-drafts': true }, keywords: { $draft: true }, size: 2400, receivedAt: hoursAgo(6),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [], cc: [],
    subject: 'Blog post: a JMAP client in 200 lines',
    preview: 'IMAP makes you ask twelve times. JMAP lets you ask once. That is most of the difference...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-052', size: 560, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'A JMAP client in 200 lines\n\nIMAP makes you ask twelve times. JMAP lets you ask once, and that is most of the difference. The rest is JSON over HTTP, which means the whole thing fits in a file you can read on a train.\n\nWe will get a session, list mailboxes, page through an inbox and send one message.\n\n[TODO: session discovery, mention the .well-known redirect trap]\n[TODO: back-references, this is the part people miss]\n[TODO: error handling, the "notCreated" shape is unusual]\n[TODO: closing, do not turn it into a manifesto]' },
    },
  },
  {
    id: 'email-032', threadId: 'thread-027', mailboxIds: { 'mb-drafts': true }, keywords: { $draft: true }, size: 1800, receivedAt: daysAgo(1),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'CFP Committee', email: 'cfp@fosdem.example' }], cc: [],
    subject: 'Talk proposal: webmail on JMAP',
    preview: 'Title: What a webmail client looks like when the protocol is on your side...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-053', size: 460, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Title: What a webmail client looks like when the protocol is on your side\n\nAbstract:\nWe built a webmail client on JMAP instead of an IMAP bridge. This talk covers what got easier (sync, push, search), what got harder (nothing else speaks it yet), and the three places where the spec left us to decide for ourselves.\n\nTrack: Modern Email\nFormat: 30 minutes\nLevel: intermediate\n\n[TODO: speaker bio, keep it to three lines]\n[TODO: outline, five bullets is enough]' },
    },
  },
  // =====================================================================
  // JUNK
  // =====================================================================
  {
    id: 'email-010', threadId: 'thread-009', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 4500, receivedAt: daysAgo(1),
    from: [{ name: 'EuroMillions Claims Dept', email: 'claims@euro-lotto-payout.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'FINAL NOTICE: your prize of €1.000.000 is waiting',
    preview: 'Your email address was drawn in our international promotional draw. To release the funds we require your bank details.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-015', size: 520, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'ATTENTION BENEFICIARY,\n\nYour email address was drawn in our international promotional draw held in Madrid. Prize: ONE MILLION EURO (€1.000.000,00).\n\nTo release the funds our processing office requires:\n1. Full name and address\n2. Copy of passport\n3. IBAN and BIC\n4. Processing fee of €450 (refundable)\n\nReply within 72 hours or the prize passes to the next beneficiary.\n\nMrs. Elizabeth Okon\nClaims Officer' },
    },
  },
  {
    id: 'email-033', threadId: 'thread-028', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 2200, receivedAt: hoursAgo(8),
    from: [{ name: 'HTCPCP Service', email: 'noreply@teapot.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '418 I am a teapot',
    preview: 'Per RFC 2324 this server is a teapot. Your BREW request has been declined.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-054', size: 250, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'HTTP/1.1 418 I am a teapot\nContent-Type: message/coffeepot\n\nPer RFC 2324, this server is a teapot. It is short and stout. Your BREW request has been declined.\n\nPlease direct it at a device that can actually make coffee.' },
    },
  },
  {
    id: 'email-034', threadId: 'thread-029', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 1900, receivedAt: daysAgo(2),
    from: [{ name: 'CryptoTrader Pro', email: 'earn@crypto-gains.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Turn €100 into €10.000 in 7 days 🚀',
    preview: 'Our trading bot closed 99,9% of positions in profit last month. Places are limited.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-055', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'LIMITED PLACES!!!\n\nOur trading bot closed 99,9% of positions in profit last month.\n\n- No experience needed\n- Withdraw any time*\n- Start with only €100\n\nSign up today at crypto-gains.example\n\n*after the 90 day qualifying period' },
    },
  },
  // =====================================================================
  // ARCHIVE
  // =====================================================================
  {
    id: 'email-011', threadId: 'thread-010', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true }, size: 3800, receivedAt: daysAgo(14),
    from: [{ name: 'People & Culture', email: 'hr@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Leave policy from 1 April',
    preview: 'Annual leave goes to 30 days for everyone, and approval moves out of email and into the HR system.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-016', size: 620, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'The leave policy changes on 1 April.\n\nAnnual leave goes to 30 days for everyone, including the two contracts that were on 25. Days already booked keep their approval.\n\nCarry-over is capped at 10 days and expires on 31 March of the following year. This is new, and it is the part people will read too late.\n\nApproval moves out of email and into the HR system. Your manager gets a notification, you get a calendar entry when it is approved.\n\nThe handbook has the full text. Questions go to hr@, not to your manager, we would rather answer once.\n\nPeople & Culture' },
    },
  },
  {
    id: 'email-012', threadId: 'thread-011', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true, $flagged: true }, size: 2600, receivedAt: daysAgo(30),
    from: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Your talk was accepted',
    preview: 'Day one, 14:00, main hall. Thirty minutes plus ten for questions.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-017', size: 380, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'The committee took "Building modern webmail with JMAP" for the Amsterdam conference.\n\nDay one, 14:00, main hall. Thirty minutes plus ten for questions. They want slides by the Friday before, in PDF, because the last speaker who brought Keynote cost them twenty minutes.\n\nTravel is booked, hotel is not. Tell me if you want the one next to the RAI or the quiet one twenty minutes away.\n\nSophie' },
    },
  },
  {
    id: 'email-035', threadId: 'thread-030', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true }, size: 4200, receivedAt: daysAgo(60),
    from: [{ name: 'IT', email: 'it@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Your development setup',
    preview: 'Everything you need for the first day, in the order that works.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-056', size: 820, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Welcome. Everything you need for the first day, in the order that works:\n\n1. git clone git@gitlab.example:fjord/monorepo.git\n2. npm install (node 22, the repo pins it)\n3. docker compose up -d for Postgres and the mail server\n4. cp .env.example .env, then ask in #dev-onboarding for the two secrets that are not in it\n5. npm test, which should be green before you change anything\n\nAccounts: GitLab and Jira are behind SSO, so your login already works. The hosting console needs an IAM user, it is in your Bitwarden collection.\n\nThe setup guide is attached. It is a year old and mostly right. Where it is wrong, edit it, that is what it is for.\n\nIT' },
    },
    attachments: [
      { partId: 'att6', blobId: 'blob-att-006', size: 125000, name: 'Entwicklung-Setup-Guide.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-036', threadId: 'thread-031', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true, $flagged: true }, size: 3100, receivedAt: daysAgo(45),
    from: [{ name: 'ELSTER Online', email: 'noreply@elster.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Ihre Dokumente für die Steuererklärung 2025 stehen bereit',
    preview: 'Lohnsteuerbescheinigung und Bescheinigung über gezahlte Kirchensteuer liegen im Postfach bereit.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-057', size: 380, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Sehr geehrte Steuerpflichtige, sehr geehrter Steuerpflichtiger,\n\nfolgende Dokumente stehen in Ihrem Postfach bereit:\n\n- Lohnsteuerbescheinigung 2025\n- Bescheinigung über gezahlte Kirchensteuer\n- Vorausgefüllte Steuererklärung (Entwurf)\n\nAbgabefrist ohne steuerliche Beratung: 31. Juli 2026.\n\nBitte melden Sie sich mit Ihrem Zertifikat unter elster.example an. Wir fordern Sie niemals per E-Mail zur Eingabe Ihrer Zugangsdaten auf.\n\nMit freundlichen Grüßen\nIhr Finanzamt' },
    },
    attachments: [
      { partId: 'att7', blobId: 'blob-att-007', size: 89000, name: 'Steuerdokumente-2025.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-037', threadId: 'thread-032', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true, $flagged: true }, size: 2800, receivedAt: daysAgo(20),
    from: [{ name: 'Chiara Rossi', email: 'chiara@rossi.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }],
    subject: 'Photos from Friday',
    preview: 'Everything from Friday evening, unsorted. Tell me if you want one taken down.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-058', size: 200, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Everything from Friday evening, unsorted, 84 of them.\n\nThere are four where Pierre is mid-sentence and looks furious. I kept them.\n\nTell me if you want one taken down before I put the album anywhere else.\n\nChiara' },
    },
    attachments: [
      { partId: 'att8', blobId: 'blob-att-008', size: 2400000, name: 'fotos-vrijdag.zip', type: 'application/zip' },
    ],
  },
  // =====================================================================
  // TRASH
  // =====================================================================
  {
    id: 'email-038', threadId: 'thread-033', mailboxIds: { 'mb-trash': true }, keywords: { $seen: true }, size: 3500, receivedAt: daysAgo(1),
    from: [{ name: 'Kanbanist', email: 'hello@kanbanist.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Your trial ends Sunday',
    preview: 'Annual plans are 30% off until Sunday. After that your workspace goes read-only.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-059', size: 420, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-065', size: 1200, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Your trial ends on Sunday 15 March.\n\nAnnual plans are 30% off until then: €84 per user per year instead of €120.\n\nAfter Sunday your workspace stays readable for 30 days, then it is deleted. Exports are in Settings > Data.\n\nkanbanist.example/billing' },
      p2: { value: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#2b3038;max-width:520px;"><p style="margin:0 0 14px 0;">Your trial ends on <strong>Sunday 15 March</strong>.</p><p style="margin:0 0 18px 0;">Annual plans are 30% off until then: <strong>€84</strong> per user per year instead of €120.</p><p style="margin:0 0 20px 0;">After Sunday your workspace stays readable for 30 days, then it is deleted. Exports live in Settings &rsaquo; Data.</p><a href="#" style="display:inline-block;background:#2b3038;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;">Choose a plan</a><p style="margin:22px 0 0 0;font-size:12px;color:#8a909a;border-top:1px solid #e8eaee;padding-top:12px;">Kanbanist BV, Keizersgracht 62, 1015 CS Amsterdam &middot; <a href="#" style="color:#8a909a;">Unsubscribe</a></p></div>' },
    },
  },
];

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

type MockIdentity = {
  id: string;
  name: string;
  email: string;
  replyTo: Array<{ name?: string; email: string }> | null;
  bcc: Array<{ name?: string; email: string }> | null;
  textSignature: string | null;
  htmlSignature: string | null;
  mayDelete: boolean;
};

const IDENTITIES: MockIdentity[] = [
  {
    id: 'identity-001',
    name: 'Dev User',
    email: 'dev@localhost',
    replyTo: null,
    bcc: null,
    textSignature: 'Dev User\nBulwark Webmail Developer',
    htmlSignature: '<p>Dev User<br><em>Bulwark Webmail Developer</em></p>',
    mayDelete: false,
  },
];

// ---------------------------------------------------------------------------
// Address Books & Contacts
// ---------------------------------------------------------------------------

const addressBooks: Array<Record<string, unknown> & { id: string; name: string }> = [
  { id: 'ab-1', name: 'Personal', isDefault: true },
  { id: 'ab-2', name: 'Work', isDefault: false },
];

// Profile photos served straight from randomuser.me's CDN; the API at
// https://randomuser.me/api/ also returns these portrait URLs, but for a
// fixed mock dataset we link them directly to keep things offline-friendly.
// See https://randomuser.me/documentation#howto
const PORTRAIT = (gender: 'men' | 'women', n: number) => `https://randomuser.me/api/portraits/${gender}/${n}.jpg`;

const contacts = [
  // --- Personal address book ---
  { id: 'contact-001', uid: 'urn:uuid:c0000001-0000-0000-0000-000000000001', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Sophie' }, { kind: 'surname', value: 'Müller' }] },
    emails: { e1: { address: 'sophie@eurotech.example' } },
    phones: { p1: { number: '+49 30 8844 2200' } },
    organizations: { o1: { name: 'EuroTech GmbH' } },
    addresses: { a1: { street: [{ value: 'Kurfürstendamm 42' }], locality: 'Berlin', region: '', country: 'Germany', postcode: '10719' } },
    notes: { n1: { note: 'Frontend lead at EuroTech. Reviews quickly, comments at length.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 14), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-002', uid: 'urn:uuid:c0000002-0000-0000-0000-000000000002', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Pierre' }, { kind: 'surname', value: 'Dubois' }] },
    emails: { e1: { address: 'pierre@dubois.example' } },
    phones: { p1: { number: '+33 1 42 68 53 00' } },
    organizations: { o1: { name: 'Dubois Consulting' } },
    addresses: { a1: { street: [{ value: '42 Rue de Rivoli' }], locality: 'Paris', country: 'France', postcode: '75001' } },
    notes: { n1: { note: 'Product manager. Would rather have a call than a thread.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 23), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-003', uid: 'urn:uuid:c0000003-0000-0000-0000-000000000003', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Chiara' }, { kind: 'surname', value: 'Rossi' }] },
    emails: { e1: { address: 'chiara@rossi.example' } },
    phones: { p1: { number: '+39 02 7634 5678' } },
    organizations: { o1: { name: 'Rossi Design Studio' } },
    addresses: { a1: { street: [{ value: 'Via Montenapoleone 8' }], locality: 'Milano', country: 'Italy', postcode: '20121' } },
    notes: { n1: { note: 'UX designer. Sends mockups as PDFs and will not be talked out of it.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 40), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-004', uid: 'urn:uuid:c0000004-0000-0000-0000-000000000004', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Karel' }, { kind: 'surname', value: 'de Vries' }] },
    emails: { e1: { address: 'karel@devries.example' } },
    phones: { p1: { number: '+31 20 555 0142' } },
    addresses: { a1: { street: [{ value: 'Herengracht 142' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1015 BN' } },
    notes: { n1: { note: 'Backend developer. Filed half of our open issues, most of them valid.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 45), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-005', uid: 'urn:uuid:c0000005-0000-0000-0000-000000000005', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Lars' }, { kind: 'surname', value: 'Johansson' }] },
    emails: { e1: { address: 'lars.johansson@fjord-systems.example' } },
    phones: { p1: { number: '+46 8 123 456 78' } },
    organizations: { o1: { name: 'Fjord Systems AB' } },
    addresses: { a1: { street: [{ value: 'Drottninggatan 42' }], locality: 'Stockholm', country: 'Sweden', postcode: '111 51' } },
    notes: { n1: { note: 'Tech lead in Stockholm. Nothing after 15:00 his time.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 61), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-006', uid: 'urn:uuid:c0000006-0000-0000-0000-000000000006', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Élise' }, { kind: 'surname', value: 'Moreau' }] },
    emails: { e1: { address: 'elise.moreau@fjord-systems.example' } },
    phones: { p1: { number: '+33 6 12 34 56 78' } },
    organizations: { o1: { name: 'Fjord Systems AB' } },
    addresses: { a1: { street: [{ value: '15 Boulevard Saint-Germain' }], locality: 'Paris', country: 'France', postcode: '75005' } },
    notes: { n1: { note: 'Backend developer, remote from Paris. Overlaps with Stockholm until 17:00.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 29), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-007', uid: 'urn:uuid:c0000007-0000-0000-0000-000000000007', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Francesco' }, { kind: 'surname', value: 'Bianchi' }] },
    emails: { e1: { address: 'francesco@bianchi.example' } },
    phones: { p1: { number: '+39 06 9876 5432' } },
    addresses: { a1: { street: [{ value: 'Via dei Condotti 22' }], locality: 'Roma', country: 'Italy', postcode: '00187' } },
    notes: { n1: { note: 'Old university friend. Runs a bookshop in Rome and still argues about type systems.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 72), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-008', uid: 'urn:uuid:c0000008-0000-0000-0000-000000000008', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Astrid' }, { kind: 'surname', value: 'van der Berg' }] },
    emails: { e1: { address: 'astrid@berglabs.example' } },
    phones: { p1: { number: '+31 70 362 4242' } },
    organizations: { o1: { name: 'BergLabs' } },
    addresses: { a1: { street: [{ value: 'Prinsengracht 263' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1016 GV' } },
    notes: { n1: { note: 'Solutions architect. Keeps the service diagram, ask her before drawing another one.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 58), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-009', uid: 'urn:uuid:c0000009-0000-0000-0000-000000000009', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Henrik' }, { kind: 'surname', value: 'Nielsen' }] },
    emails: { e1: { address: 'henrik@nielsen-konsult.example' } },
    phones: { p1: { number: '+45 33 42 42 42' } },
    organizations: { o1: { name: 'Nielsen Konsult' } },
    addresses: { a1: { street: [{ value: 'Nyhavn 42' }], locality: 'København', country: 'Denmark', postcode: '1051' } },
    notes: { n1: { note: 'Freelance SRE. On call for our deployment windows, invoices monthly.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 35), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-010', uid: 'urn:uuid:c0000010-0000-0000-0000-000000000010', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Isabelle' }, { kind: 'surname', value: 'Martin' }] },
    emails: { e1: { address: 'isabelle.martin@sorbonne.example' } },
    phones: { p1: { number: '+33 1 44 27 42 42' } },
    organizations: { o1: { name: 'Sorbonne Université' } },
    addresses: { a1: { street: [{ value: '21 Rue de l\'École de Médecine' }], locality: 'Paris', country: 'France', postcode: '75006' } },
    notes: { n1: { note: 'Professor of computer science. Works on formal verification of mail protocols.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 63), mediaType: 'image/jpeg' } },
  },
  // --- Work address book ---
  { id: 'contact-011', uid: 'urn:uuid:c0000011-0000-0000-0000-000000000011', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Jacques' }, { kind: 'surname', value: 'Lefèvre' }] },
    emails: { e1: { address: 'jacques@lefevre-avocats.example' } },
    phones: { p1: { number: '+33 1 53 67 42 00' } },
    organizations: { o1: { name: 'Lefèvre & Associés' } },
    addresses: { a1: { street: [{ value: '8 Avenue de l\'Opéra' }], locality: 'Paris', country: 'France', postcode: '75001' } },
    notes: { n1: { note: 'Contract and IP law. Bills in six-minute units, so keep the email short.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 81), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-012', uid: 'urn:uuid:c0000012-0000-0000-0000-000000000012', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Katrin' }, { kind: 'surname', value: 'Bauer' }] },
    emails: { e1: { address: 'katrin.bauer@charite.example' } },
    phones: { p1: { number: '+49 30 450 570 000' } },
    organizations: { o1: { name: 'Charité Klinik Berlin' } },
    addresses: { a1: { street: [{ value: 'Charitéplatz 1' }], locality: 'Berlin', country: 'Germany', postcode: '10117' } },
    notes: { n1: { note: 'Organises the Berlin team evenings. Books everything three months ahead.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 26), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-013', uid: 'urn:uuid:c0000013-0000-0000-0000-000000000013', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Liam' }, { kind: 'surname', value: 'Ó Donaill' }] },
    emails: { e1: { address: 'liam.odonaill@finanz.example' } },
    phones: { p1: { number: '+353 1 677 4242' } },
    organizations: { o1: { name: 'Finanz Dublin' } },
    addresses: { a1: { street: [{ value: '42 St. Stephen\'s Green' }], locality: 'Dublin', country: 'Ireland', postcode: 'D02 HX65' } },
    notes: { n1: { note: 'Finance lead in Dublin. Wants the numbers before the meeting, not during it.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 19), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-014', uid: 'urn:uuid:c0000014-0000-0000-0000-000000000014', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'María' }, { kind: 'surname', value: 'García' }] },
    emails: { e1: { address: 'maria@garcia-design.example' } },
    phones: { p1: { number: '+34 91 420 4242' } },
    organizations: { o1: { name: 'García Design Studio' } },
    addresses: { a1: { street: [{ value: 'Calle Gran Vía 42' }], locality: 'Madrid', country: 'Spain', postcode: '28013' } },
    notes: { n1: { note: 'Brand designer. Owns the Figma library, ask before inventing a shade.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 50), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-015', uid: 'urn:uuid:c0000015-0000-0000-0000-000000000015', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Nils' }, { kind: 'surname', value: 'Andersson' }] },
    emails: { e1: { address: 'nils@digitaal.example' } },
    phones: { p1: { number: '+31 20 624 8815' } },
    organizations: { o1: { name: 'Digitaal BV' } },
    addresses: { a1: { street: [{ value: 'Vijzelstraat 42' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1017 HK' } },
    notes: { n1: { note: 'Platform engineer. Knows where the old DNS records are buried.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 57), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-016', uid: 'urn:uuid:c0000016-0000-0000-0000-000000000016', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Olivia' }, { kind: 'surname', value: 'Kowalska' }] },
    emails: { e1: { address: 'olivia@kowalska-marketing.example' } },
    phones: { p1: { number: '+48 22 505 4242' } },
    organizations: { o1: { name: 'Kowalska Marketing' } },
    addresses: { a1: { street: [{ value: 'ul. Nowy Świat 42' }], locality: 'Warszawa', country: 'Poland', postcode: '00-363' } },
    notes: { n1: { note: 'Marketing strategist. Runs the campaign reporting.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 71), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-017', uid: 'urn:uuid:c0000017-0000-0000-0000-000000000017', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Pádraig' }, { kind: 'surname', value: 'Murphy' }] },
    emails: { e1: { address: 'padraig@murphy-bau.example' } },
    phones: { p1: { number: '+353 86 123 4242' } },
    organizations: { o1: { name: 'Murphy Bau GmbH' } },
    addresses: { a1: { street: [{ value: 'Grafton Street 42' }], locality: 'Dublin', country: 'Ireland', postcode: 'D02 R296' } },
    notes: { n1: { note: 'Runs the Dublin office fit-out. Reachable by phone, not by email.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 93), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-018', uid: 'urn:uuid:c0000018-0000-0000-0000-000000000018', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Raquel' }, { kind: 'surname', value: 'Ferreira' }] },
    emails: { e1: { address: 'raquel@ferreira-media.example' } },
    phones: { p1: { number: '+351 21 342 4242' } },
    organizations: { o1: { name: 'Ferreira Media' } },
    addresses: { a1: { street: [{ value: 'Rua Augusta 42' }], locality: 'Lisboa', country: 'Portugal', postcode: '1100-053' } },
    notes: { n1: { note: 'Media consultant. Handles press for the Lisbon launch.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 82), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-019', uid: 'urn:uuid:c0000019-0000-0000-0000-000000000019', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Sébastien' }, { kind: 'surname', value: 'Dumont' }] },
    emails: { e1: { address: 'sebastien@dumont-conseil.example' } },
    phones: { p1: { number: '+32 2 555 4242' } },
    organizations: { o1: { name: 'Dumont Conseil' } },
    addresses: { a1: { street: [{ value: 'Avenue Louise 42' }], locality: 'Bruxelles', country: 'Belgium', postcode: '1050' } },
    notes: { n1: { note: 'Strategy consultant in Brussels. Good on procurement questions.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('men', 4), mediaType: 'image/jpeg' } },
  },
  { id: 'contact-020', uid: 'urn:uuid:c0000020-0000-0000-0000-000000000020', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Annika' }, { kind: 'surname', value: 'Lindgren' }] },
    emails: { e1: { address: 'annika@lindgren.example' }, e2: { address: 'annika.personal@proton.example' } },
    phones: { p1: { number: '+46 70 123 4242' } },
    organizations: { o1: { name: 'Lindgren Consulting' } },
    addresses: { a1: { street: [{ value: 'Strandvägen 42' }], locality: 'Stockholm', country: 'Sweden', postcode: '114 56' } },
    nicknames: { n1: { name: 'Anni' } },
    notes: { n1: { note: 'Data protection consultant. Reviewed our privacy notice in January.' } },
    media: { photo1: { kind: 'photo' as const, uri: PORTRAIT('women', 36), mediaType: 'image/jpeg' } },
  },
  // --- Groups ---
  { id: 'contact-group-001', addressBookIds: { 'ab-1': true }, kind: 'group' as const,
    uid: 'urn:uuid:g0000001-0000-0000-0000-000000000001',
    name: { components: [{ kind: 'given' as const, value: 'Fjord Systems Team' }], isOrdered: true },
    members: { 'urn:uuid:c0000005-0000-0000-0000-000000000005': true, 'urn:uuid:c0000006-0000-0000-0000-000000000006': true },
  },
  { id: 'contact-group-002', addressBookIds: { 'ab-1': true }, kind: 'group' as const,
    uid: 'urn:uuid:g0000002-0000-0000-0000-000000000002',
    name: { components: [{ kind: 'given' as const, value: 'Design Friends' }], isOrdered: true },
    members: { 'urn:uuid:c0000003-0000-0000-0000-000000000003': true, 'urn:uuid:c0000007-0000-0000-0000-000000000007': true },
  },
  { id: 'contact-group-003', addressBookIds: { 'ab-2': true }, kind: 'group' as const,
    uid: 'urn:uuid:g0000003-0000-0000-0000-000000000003',
    name: { components: [{ kind: 'given' as const, value: 'Legal & Finance' }], isOrdered: true },
    members: { 'urn:uuid:c0000011-0000-0000-0000-000000000011': true, 'urn:uuid:c0000013-0000-0000-0000-000000000013': true },
  },
];

// ---------------------------------------------------------------------------
// Calendars & Events
// ---------------------------------------------------------------------------

const mockCalendars = [
  { id: 'cal-1', name: 'Personal', color: '#4285f4', isVisible: true, isDefault: true },
  { id: 'cal-2', name: 'Work', color: '#0b8043', isVisible: true, isDefault: false },
  { id: 'cal-3', name: 'Team', color: '#8e24aa', isVisible: true, isDefault: false },
  { id: 'cal-4', name: 'Public holidays', color: '#f4511e', isVisible: true, isDefault: false },
  { id: 'cal-5', name: 'Birthdays', color: '#e67c73', isVisible: true, isDefault: false },
];

function makeEvent(
  id: string, calendarId: string, title: string,
  start: string, duration: string,
  opts: {
    location?: string, description?: string, showWithoutTime?: boolean,
    recurrence?: object[], participants?: Record<string, object>,
    virtualLocations?: Record<string, object>,
    alerts?: Record<string, object>, status?: string, color?: string,
  } = {},
) {
  return {
    id,
    calendarIds: { [calendarId]: true },
    title,
    start,
    duration,
    timeZone: 'Europe/Amsterdam',
    showWithoutTime: opts.showWithoutTime || false,
    status: opts.status || 'confirmed',
    ...(opts.location ? { locations: { loc1: { name: opts.location } } } : {}),
    ...(opts.virtualLocations ? { virtualLocations: opts.virtualLocations } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.recurrence ? { recurrenceRules: opts.recurrence } : {}),
    ...(opts.participants ? { participants: opts.participants } : {}),
    ...(opts.alerts ? { alerts: opts.alerts } : {}),
    ...(opts.color ? { color: opts.color } : {}),
  };
}

function participant(name: string, email: string, kind: string = 'attendee') {
  return { name, sendTo: { imip: `mailto:${email}` }, kind, participationStatus: 'accepted', expectReply: false };
}

const calendarEvents = [
  // ===== Work calendar (cal-2) - recurring & meetings =====
  makeEvent('evt-001', 'cal-2', 'Daily Standup', localDateTime(0, 9, 0), 'PT15M', {
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'tu' }, { day: 'we' }, { day: 'th' }, { day: 'fr' }] }],
    virtualLocations: { vl1: { uri: 'https://meet.example/standup', name: 'Google Meet', description: 'Daily sync' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
      p3: participant('Sophie Müller', 'sophie@eurotech.example'),
      p4: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
    },
    alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'start' }, action: 'display' } },
  }),
  makeEvent('evt-002', 'cal-2', 'Sprint Planning', localDateTime(1, 10, 30), 'PT1H30M', {
    location: 'Room A',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
      p3: participant('Sophie Müller', 'sophie@eurotech.example'),
      p4: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
      p5: participant('Astrid van der Berg', 'astrid@berglabs.example'),
    },
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'mo' }], interval: 2 }],
    alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' }, action: 'display' } },
  }),
  makeEvent('evt-003', 'cal-2', '1:1 with Lars', localDateTime(0, 14, 0), 'PT30M', {
    virtualLocations: { vl1: { uri: 'https://meet.example/lars-dev', name: 'Zoom' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
    },
    description: 'Weekly catch-up.',
  }),
  makeEvent('evt-004', 'cal-2', 'Code Review Session', localDateTime(0, 16, 0), 'PT1H', {
    location: 'Room B',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
    },
    description: 'Walk through the vCard import PR, mainly the merge dialogue.',
  }),
  makeEvent('evt-005', 'cal-2', 'Architecture Review', localDateTime(2, 11, 0), 'PT1H30M', {
    location: 'Room A',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Astrid van der Berg', 'astrid@berglabs.example'),
      p3: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
      p4: participant('Henrik Nielsen', 'henrik@nielsen-konsult.example'),
    },
    description: 'Review microservices → JMAP migration architecture.',
  }),
  // Overlapping event - deliberate conflict with Architecture Review
  makeEvent('evt-006', 'cal-2', 'Customer Call - EuroTech', localDateTime(2, 11, 30), 'PT45M', {
    virtualLocations: { vl1: { uri: 'https://meet.example/eurotech', name: 'Teams' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Sophie Müller', 'sophie@eurotech.example'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
    },
    description: 'Rate limit escalation on the EuroTech account, ticket #4521.',
  }),
  makeEvent('evt-007', 'cal-2', 'Deployment Window', localDateTime(3, 22, 0), 'PT2H', {
    description: 'Calendar integration v2.3 goes to production. The rollback plan is in the runbook, Henrik is on call.',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Henrik Nielsen', 'henrik@nielsen-konsult.example'),
    },
    alerts: {
      a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'start' }, action: 'display' },
      a2: { trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'start' }, action: 'email' },
    },
  }),
  makeEvent('evt-008', 'cal-2', 'Q1 Budget Review', localDateTime(3, 14, 0), 'PT1H', {
    location: 'Room B',
    participants: {
      p1: participant('Liam Ó Donaill', 'liam.odonaill@finanz.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Nils Andersson', 'nils@digitaal.example'),
    },
  }),
  makeEvent('evt-009', 'cal-2', 'Retro & Demo', localDateTime(4, 15, 0), 'PT1H30M', {
    location: 'Room A',
    virtualLocations: { vl1: { uri: 'https://meet.example/retro', name: 'Google Meet' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
      p3: participant('Sophie Müller', 'sophie@eurotech.example'),
      p4: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
      p5: participant('Astrid van der Berg', 'astrid@berglabs.example'),
      p6: participant('Pierre Dubois', 'pierre@dubois.example'),
    },
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'fr' }], interval: 2 }],
  }),
  makeEvent('evt-010', 'cal-2', 'Brand Guidelines Review', localDateTime(5, 10, 0), 'PT1H', {
    virtualLocations: { vl1: { uri: 'https://meet.example/brand', name: 'Figma + Zoom' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost'),
      p2: participant('María García', 'maria@garcia-design.example', 'owner'),
      p3: participant('Sophie Müller', 'sophie@eurotech.example'),
    },
  }),
  makeEvent('evt-011', 'cal-2', 'API Deprecation Deadline', localDateTime(30, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Payment API v2023-10 stops answering today. Both keys have to be on v2025-01.',
    color: '#d50000',
  }),

  // ===== Team calendar (cal-3) - social & team =====
  makeEvent('evt-012', 'cal-3', 'Team evening', localDateTime(5, 18, 0), 'PT3H', {
    location: 'Restaurante Fado, Zeedijk 62, Amsterdam',
    description: 'Set menu, paid by the company. Vegetarian option has to be flagged by Wednesday.',
    participants: {
      p1: participant('Katrin Bauer', 'katrin.bauer@charite.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
      p4: participant('Chiara Rossi', 'chiara@rossi.example'),
      p5: participant('Sophie Müller', 'sophie@eurotech.example'),
    },
  }),
  makeEvent('evt-013', 'cal-3', 'Team Retro: What went well?', localDateTime(-2, 16, 0), 'PT1H', {
    virtualLocations: { vl1: { uri: 'https://meet.example/retro-board', name: 'Miro + Meet' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
      p3: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
      p4: participant('Sophie Müller', 'sophie@eurotech.example'),
    },
  }),
  makeEvent('evt-014', 'cal-3', 'Lunch & learn: how JMAP batches requests', localDateTime(4, 12, 0), 'PT1H', {
    location: 'Canteen, second floor',
    description: 'Dev User walks through batching and back-references, with the numbers from the prototype. Pizza at 12:00, talk at 12:15.',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Astrid van der Berg', 'astrid@berglabs.example'),
      p3: participant('Isabelle Martin', 'isabelle.martin@sorbonne.example'),
    },
  }),
  makeEvent('evt-015', 'cal-3', 'Quarterly all-hands', localDateTime(60, 15, 0), 'PT1H30M', {
    location: 'Room A, and streamed',
    description: 'Numbers, roadmap, questions. Send questions in advance if you want an answer that has been thought about.',
    participants: {
      p1: participant('Sophie Müller', 'sophie@eurotech.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
      p4: participant('Chiara Rossi', 'chiara@rossi.example'),
      p5: participant('Katrin Bauer', 'katrin.bauer@charite.example'),
      p6: participant('Nils Andersson', 'nils@digitaal.example'),
    },
  }),
  makeEvent('evt-016', 'cal-3', 'Pasta course', localDateTime(12, 18, 30), 'PT2H30M', {
    location: 'La Cucina, Jordaan, Amsterdam',
    description: 'Three hours, you eat what you make. Chiara is teaching, which she volunteered for and may come to regret.',
    participants: {
      p1: participant('Chiara Rossi', 'chiara@rossi.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
      p4: participant('Katrin Bauer', 'katrin.bauer@charite.example'),
    },
  }),

  // ===== Personal calendar (cal-1) =====
  makeEvent('evt-017', 'cal-1', 'Fika with Nils', localDateTime(2, 15, 30), 'PT1H', {
    location: 'Koffiehuis Prinsengracht, Amsterdam',
    description: 'Catch-up over coffee.',
  }),
  makeEvent('evt-018', 'cal-1', 'Lake Como Weekend', localDateTime(14, 10, 0), 'P2D', {
    location: 'Villa sul Lago, Bellagio, Lake Como',
    description: 'Reservation LS-4419-BG.\nCheck-in from 15:00, check-out by 11:00.\nThe key box code is in the voucher.',
    showWithoutTime: true,
  }),
  makeEvent('evt-019', 'cal-1', 'Tandarts (Dentist)', localDateTime(7, 9, 30), 'PT45M', {
    location: 'Tandartspraktijk Centrum, Reguliersgracht 12, Amsterdam',
    description: 'Six-month check-up.',
    alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'start' }, action: 'display' } },
  }),
  makeEvent('evt-020', 'cal-1', 'Albert Cuyp Markt', localDateTime(6, 10, 0), 'PT2H', {
    location: 'Albert Cuypstraat, Amsterdam',
    description: 'Market run. Bread, cheese, olives, and whatever looks good.',
    showWithoutTime: false,
  }),
  makeEvent('evt-021', 'cal-1', 'Cycling to Vondelpark', localDateTime(6, 14, 0), 'PT1H30M', {
    location: 'Vondelpark, Amsterdam',
    description: 'Meet at the main entrance.',
  }),
  makeEvent('evt-022', 'cal-1', 'Yoga Class', localDateTime(0, 7, 0), 'PT1H', {
    location: 'De Nieuwe Yogaschool, Laurierstraat, Amsterdam',
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }, { day: 'fr' }] }],
  }),
  makeEvent('evt-023', 'cal-1', 'Dutch Language Lesson', localDateTime(1, 19, 0), 'PT1H30M', {
    location: 'Taleninstituut, Plantage Middenlaan, Amsterdam',
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'tu' }] }],
    description: 'Semester 3: past tense and separable verbs.',
  }),
  makeEvent('evt-024', 'cal-1', 'Call with Mum', localDateTime(0, 18, 30), 'PT30M', {
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'su' }] }],
    description: 'Weekly call home.',
  }),
  // Overlapping personal events
  makeEvent('evt-025', 'cal-1', 'Haircut', localDateTime(6, 14, 30), 'PT45M', {
    location: 'Kapper de Luxe, Utrechtsestraat, Amsterdam',
    description: 'Overlaps with the bike ride. One of them has to move.',
  }),

  // ===== Holiday calendar (cal-4) - all-day events =====
  makeEvent('evt-026', 'cal-4', 'Koningsdag', localDateTime(42, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Public holiday in the Netherlands. Shops shut, the city centre is closed to cars.',
    color: '#ff6d00',
  }),
  makeEvent('evt-027', 'cal-4', 'Tag der Arbeit', localDateTime(48, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Public holiday in most of Europe. Stockholm and Berlin are closed.',
  }),
  makeEvent('evt-028', 'cal-4', 'Hemelvaartsdag', localDateTime(55, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Public holiday in the Netherlands. Most people take the Friday as well.',
  }),
  makeEvent('evt-029', 'cal-4', 'Bevrijdingsdag', localDateTime(52, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Liberation Day. A holiday for us, not for every employer in the country.',
  }),

  // ===== Birthday calendar (cal-5) =====
  makeEvent('evt-030', 'cal-5', '🎂 Sophie Müller', localDateTime(8, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'She has said twice that she wants nothing. Bring cake anyway.',
  }),
  makeEvent('evt-031', 'cal-5', '🎂 Chiara Rossi', localDateTime(21, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Tiramisu, not cake.',
  }),
  makeEvent('evt-032', 'cal-5', '🎂 Pierre Dubois', localDateTime(45, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Wine, and he will notice which one.',
  }),
  makeEvent('evt-033', 'cal-5', '🎂 Lars Johansson', localDateTime(-3, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Was last week. It was not remembered.',
  }),

  // ===== JMAP Conf & travel (work calendar) =====
  makeEvent('evt-034', 'cal-2', 'JMAP Conf Amsterdam', localDateTime(28, 9, 0), 'P2D', {
    location: 'RAI Amsterdam Convention Centre',
    showWithoutTime: true,
    description: 'Your talk is day one, 14:00, main hall. Slides as PDF to the organisers by the Friday before.',
    participants: {
      p1: participant('Dev User', 'dev@localhost'),
      p2: participant('Sophie Müller', 'sophie@eurotech.example'),
      p3: participant('Isabelle Martin', 'isabelle.martin@sorbonne.example'),
    },
  }),
  makeEvent('evt-035', 'cal-2', 'FOSDEM Talk Prep', localDateTime(10, 13, 0), 'PT2H', {
    virtualLocations: { vl1: { uri: 'https://meet.example/fosdem-prep', name: 'Meet' } },
    description: 'Run through the FOSDEM proposal end to end and cut it down to 30 minutes.',
  }),
];

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function buildThreads() {
  const map = new Map<string, string[]>();
  for (const e of emails) {
    const ids = map.get(e.threadId) || [];
    ids.push(e.id);
    map.set(e.threadId, ids);
  }
  return Array.from(map.entries()).map(([id, emailIds]) => ({ id, emailIds }));
}

// ---------------------------------------------------------------------------
// JMAP method handlers
// ---------------------------------------------------------------------------

type MethodArgs = Record<string, unknown>;
type MethodResult = [string, Record<string, unknown>, string];
type MethodHandler = (
  args: MethodArgs,
  callId: string,
) => MethodResult | Promise<MethodResult>;

function handleCoreEcho(args: MethodArgs, callId: string): MethodResult {
  return ['Core/echo', args, callId];
}

function handleMailboxGet(_args: MethodArgs, callId: string): MethodResult {
  recomputeMailboxCounts();
  return ['Mailbox/get', { accountId: ACCOUNT_ID, state: nextState(), list: mailboxes, notFound: [] }, callId];
}

function handleMailboxSet(args: MethodArgs, callId: string): MethodResult {
  const created: Record<string, { id: string }> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];

  const create = args.create as Record<string, Record<string, unknown>> | undefined;
  if (create) {
    for (const [key, data] of Object.entries(create)) {
      const newId = `mb-${Date.now()}-${key}`;
      mailboxes.push({
        id: newId,
        name: (data.name as string) || 'New Folder',
        role: null,
        sortOrder: mailboxes.length + 1,
        totalEmails: 0,
        unreadEmails: 0,
      });
      created[key] = { id: newId };
    }
  }

  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  if (update) {
    for (const [id, changes] of Object.entries(update)) {
      const mb = mailboxes.find((m) => m.id === id);
      if (mb) {
        if (changes.name !== undefined) mb.name = changes.name as string;
        if (changes.sortOrder !== undefined) mb.sortOrder = changes.sortOrder as number;
        updated[id] = null;
      }
    }
  }

  const destroy = args.destroy as string[] | undefined;
  if (destroy) {
    for (const id of destroy) {
      const idx = mailboxes.findIndex((m) => m.id === id);
      if (idx !== -1) {
        mailboxes.splice(idx, 1);
        // Move emails from deleted mailbox to trash
        const trash = mailboxes.find((m) => m.role === 'trash');
        for (const e of emails) {
          if (e.mailboxIds[id]) {
            delete e.mailboxIds[id];
            if (trash) e.mailboxIds[trash.id] = true;
          }
        }
        destroyed.push(id);
      }
    }
  }

  recomputeMailboxCounts();
  return ['Mailbox/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created, updated, destroyed, notCreated: null, notUpdated: null, notDestroyed: null }, callId];
}

function handleEmailQuery(args: MethodArgs, callId: string): MethodResult {
  const filter = args.filter as Record<string, unknown> | undefined;
  const limit = (args.limit as number) || 50;
  const position = (args.position as number) || 0;

  let filtered = [...emails];

  // Support both flat filters and operator/conditions compound filters
  const applyFilter = (f: Record<string, unknown>, list: MockEmail[]): MockEmail[] => {
    let result = list;
    if (f.operator && Array.isArray(f.conditions)) {
      const sub = (f.conditions as Record<string, unknown>[]).map(c => applyFilter(c, result));
      if (f.operator === 'AND') {
        result = sub.reduce((acc, s) => acc.filter(e => s.includes(e)));
      } else if (f.operator === 'OR') {
        const ids = new Set(sub.flat().map(e => e.id));
        result = result.filter(e => ids.has(e.id));
      }
      return result;
    }
    if (f.inMailbox) {
      result = result.filter((e) => e.mailboxIds[f.inMailbox as string]);
    }
    if (f.text) {
      const q = (f.text as string).toLowerCase();
      result = result.filter(
        (e) =>
          (e.subject?.toLowerCase().includes(q)) ||
          (e.preview?.toLowerCase().includes(q)) ||
          e.from?.some((addr) => addr.name?.toLowerCase().includes(q) || addr.email.toLowerCase().includes(q)),
      );
    }
    if (f.hasKeyword) {
      const kw = f.hasKeyword as string;
      result = result.filter((e) => e.keywords[kw] === true);
    }
    if (f.notKeyword) {
      const kw = f.notKeyword as string;
      result = result.filter((e) => !e.keywords[kw]);
    }
    if (f.from) {
      const q = (f.from as string).toLowerCase();
      result = result.filter((e) => e.from?.some((addr) => addr.name?.toLowerCase().includes(q) || addr.email.toLowerCase().includes(q)));
    }
    if (f.to) {
      const q = (f.to as string).toLowerCase();
      result = result.filter((e) => e.to?.some((addr) => addr.name?.toLowerCase().includes(q) || addr.email.toLowerCase().includes(q)));
    }
    if (f.subject) {
      const q = (f.subject as string).toLowerCase();
      result = result.filter((e) => e.subject?.toLowerCase().includes(q));
    }
    if (f.hasAttachment === true) {
      result = result.filter((e) => e.hasAttachment);
    } else if (f.hasAttachment === false) {
      result = result.filter((e) => !e.hasAttachment);
    }
    if (f.after) {
      const after = new Date(f.after as string).getTime();
      result = result.filter((e) => new Date(e.receivedAt).getTime() >= after);
    }
    if (f.before) {
      const before = new Date(f.before as string).getTime();
      result = result.filter((e) => new Date(e.receivedAt).getTime() <= before);
    }
    return result;
  };

  if (filter) {
    filtered = applyFilter(filter, filtered);
  }

  // Sort newest first
  filtered.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

  const total = filtered.length;
  const ids = filtered.slice(position, position + limit).map((e) => e.id);

  return ['Email/query', { accountId: ACCOUNT_ID, queryState: nextState(), ids, total, position, canCalculateChanges: false }, callId];
}

function handleEmailGet(args: MethodArgs, callId: string): MethodResult {
  let ids = args.ids as string[] | undefined;
  const properties = args.properties as string[] | undefined;

  // Handle back-references (#ids)
  if (!ids && args['#ids']) {
    // Will be resolved by the caller
    ids = args['#ids'] as string[];
  }

  const list = ids
    ? emails.filter((e) => ids!.includes(e.id))
    : emails;

  // If specific properties requested, filter them
  let result: unknown[] = list;
  if (properties) {
    result = list.map((e) => {
      const filtered: Record<string, unknown> = { id: e.id };
      for (const prop of properties) {
        if (prop in e) {
          filtered[prop] = (e as unknown as Record<string, unknown>)[prop];
        }
      }
      return filtered;
    });
  }

  return ['Email/get', { accountId: ACCOUNT_ID, state: nextState(), list: result, notFound: [] }, callId];
}

function handleEmailSet(args: MethodArgs, callId: string): MethodResult {
  const updated: Record<string, null> = {};
  const created: Record<string, { id: string }> = {};
  const destroyed: string[] = [];

  // --- Handle updates (move, keywords, etc.) ---
  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  if (update) {
    for (const [id, changes] of Object.entries(update)) {
      const email = emails.find((e) => e.id === id);
      if (!email) continue;

      // Full mailboxIds replacement (move)
      if (changes.mailboxIds) {
        email.mailboxIds = changes.mailboxIds as Record<string, boolean>;
      }

      // Full keywords replacement (strip false values per JMAP spec: keywords is a set)
      if (changes.keywords !== undefined) {
        const raw = changes.keywords as Record<string, boolean>;
        const cleaned: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (v) cleaned[k] = true;
        }
        email.keywords = cleaned;
      }

      // Patch-style keyword updates: "keywords/$seen", "keywords/$flagged", etc.
      for (const [key, value] of Object.entries(changes)) {
        if (key.startsWith('keywords/')) {
          // The key is a JSON Pointer, so a nested tag arrives escaped
          // (`$label:work~1clients`) and has to be read back to its real name.
          const keyword = pointerTokenValue(key.slice('keywords/'.length));
          if (value) {
            email.keywords[keyword] = true;
          } else {
            delete email.keywords[keyword];
          }
        }
      }

      // Subject / other fields (for drafts)
      if (changes.subject !== undefined) email.subject = changes.subject as string;

      updated[id] = null;
    }
  }

  // --- Handle creates ---
  const create = args.create as Record<string, Record<string, unknown>> | undefined;
  if (create) {
    for (const [key, data] of Object.entries(create)) {
      const newId = `email-new-${Date.now()}-${key}`;
      // Extract preview text from bodyValues using textBody partId
      let previewText = '';
      const textBodyArr = data.textBody as { partId: string }[] | undefined;
      const bodyVals = data.bodyValues as Record<string, { value: string }> | undefined;
      if (Array.isArray(textBodyArr) && textBodyArr[0]?.partId && bodyVals) {
        previewText = bodyVals[textBodyArr[0].partId]?.value || '';
      } else if (typeof data.textBody === 'string') {
        previewText = data.textBody;
      }

      const newEmail: MockEmail = {
        id: newId,
        threadId: `thread-new-${Date.now()}-${key}`,
        mailboxIds: (data.mailboxIds as Record<string, boolean>) || { 'mb-drafts': true },
        keywords: (data.keywords as Record<string, boolean>) || {},
        size: 1000,
        receivedAt: new Date().toISOString(),
        from: (data.from as MockEmail['from']) || [{ name: 'Dev User', email: 'dev@localhost' }],
        to: (data.to as MockEmail['to']) || [],
        cc: (data.cc as MockEmail['cc']) || [],
        subject: (data.subject as string) || '(no subject)',
        preview: (previewText || (data.subject as string) || '').slice(0, 120),
        hasAttachment: false,
        textBody: [],
        htmlBody: [],
        bodyValues: {},
      };
      emails.unshift(newEmail);
      emailCreationIds.set(key, newId);
      created[key] = { id: newId };
    }
  }

  // --- Handle destroys (permanent delete) ---
  const destroy = args.destroy as string[] | undefined;
  if (destroy) {
    for (const id of destroy) {
      const idx = emails.findIndex((e) => e.id === id);
      if (idx !== -1) {
        emails.splice(idx, 1);
        destroyed.push(id);
      }
    }
  }

  recomputeMailboxCounts();
  return ['Email/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created, updated, destroyed, notCreated: null, notUpdated: null, notDestroyed: null }, callId];
}

function handleIdentityGet(_args: MethodArgs, callId: string): MethodResult {
  return ['Identity/get', { accountId: ACCOUNT_ID, state: nextState(), list: IDENTITIES, notFound: [] }, callId];
}

function handleIdentitySet(args: MethodArgs, callId: string): MethodResult {
  const created: Record<string, { id: string }> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];

  const create = args.create as Record<string, Record<string, unknown>> | undefined;
  if (create) {
    for (const [key, data] of Object.entries(create)) {
      const newId = `identity-${Date.now()}-${key}`;
      IDENTITIES.push({
        id: newId,
        name: (data.name as string) || '',
        email: (data.email as string) || '',
        replyTo: (data.replyTo as MockIdentity['replyTo']) ?? null,
        bcc: (data.bcc as MockIdentity['bcc']) ?? null,
        textSignature: (data.textSignature as string | null) ?? null,
        htmlSignature: (data.htmlSignature as string | null) ?? null,
        mayDelete: true,
      });
      created[key] = { id: newId };
    }
  }

  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  if (update) {
    for (const [id, changes] of Object.entries(update)) {
      const identity = IDENTITIES.find((i) => i.id === id);
      if (identity) {
        // Email is immutable per the identity form, so it's never in `changes`.
        if (changes.name !== undefined) identity.name = changes.name as string;
        if (changes.replyTo !== undefined) identity.replyTo = changes.replyTo as MockIdentity['replyTo'];
        if (changes.bcc !== undefined) identity.bcc = changes.bcc as MockIdentity['bcc'];
        if (changes.textSignature !== undefined) identity.textSignature = changes.textSignature as string | null;
        if (changes.htmlSignature !== undefined) identity.htmlSignature = changes.htmlSignature as string | null;
        updated[id] = null;
      }
    }
  }

  const destroy = args.destroy as string[] | undefined;
  if (destroy) {
    for (const id of destroy) {
      const idx = IDENTITIES.findIndex((i) => i.id === id);
      if (idx !== -1) {
        IDENTITIES.splice(idx, 1);
        destroyed.push(id);
      }
    }
  }

  return ['Identity/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created, updated, destroyed, notCreated: null, notUpdated: null, notDestroyed: null }, callId];
}

function handleThreadGet(args: MethodArgs, callId: string): MethodResult {
  const ids = args.ids as string[] | undefined;
  const threads = buildThreads();
  const list = ids ? threads.filter((t) => ids.includes(t.id)) : threads;
  return ['Thread/get', { accountId: ACCOUNT_ID, state: nextState(), list, notFound: [] }, callId];
}

function handleEmailSubmissionSet(args: MethodArgs, callId: string): MethodResult {
  const created: Record<string, { id: string; sendAt?: string }> = {};
  const updated: Record<string, null> = {};
  const create = args.create as Record<string, { emailId?: string; identityId?: string; envelope?: { mailFrom?: { parameters?: { HOLDFOR?: string; HOLDUNTIL?: string } } } }> | undefined;
  if (create) {
    for (const [key, value] of Object.entries(create)) {
      const id = `submission-${Date.now()}-${key}`;
      const holdFor = value.envelope?.mailFrom?.parameters?.HOLDFOR;
      const holdUntil = value.envelope?.mailFrom?.parameters?.HOLDUNTIL;
      const holdForSeconds = holdFor ? Number(holdFor) : Number.NaN;
      const holdUntilTime = Number.isFinite(holdForSeconds) && holdForSeconds > 0
        ? Date.now() + holdForSeconds * 1000
        : holdUntil ? new Date(holdUntil).getTime() : Number.NaN;
      const delayedUntil = Number.isFinite(holdUntilTime) ? new Date(holdUntilTime).toISOString() : undefined;
      created[key] = { id, ...(delayedUntil ? { sendAt: delayedUntil } : {}) };
      if (delayedUntil && value.emailId && value.identityId) {
        const emailId = value.emailId.startsWith('#') ? emailCreationIds.get(value.emailId.slice(1)) || value.emailId : value.emailId;
        scheduledSubmissions.push({ id, emailId, identityId: value.identityId, sendAt: delayedUntil, undoStatus: 'pending' });
      }
    }
  }
  const update = args.update as Record<string, { undoStatus?: 'pending' | 'final' | 'canceled' }> | undefined;
  if (update) {
    for (const [id, patch] of Object.entries(update)) {
      const submission = scheduledSubmissions.find(s => s.id === id);
      if (submission && patch.undoStatus) {
        submission.undoStatus = patch.undoStatus;
        updated[id] = null;
      }
    }
  }
  return ['EmailSubmission/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created, updated, notCreated: null, notUpdated: null }, callId];
}

function handleEmailSubmissionQuery(args: MethodArgs, callId: string): MethodResult {
  const position = Number(args.position || 0);
  const limit = Number(args.limit || 50);
  const submissions = [...scheduledSubmissions].sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  return ['EmailSubmission/query', { accountId: ACCOUNT_ID, queryState: nextState(), ids: submissions.slice(position, position + limit).map(s => s.id), total: submissions.length, position, canCalculateChanges: false }, callId];
}

function handleEmailSubmissionGet(args: MethodArgs, callId: string): MethodResult {
  const ids = args.ids as string[] | undefined;
  const list = ids ? scheduledSubmissions.filter(s => ids.includes(s.id)) : scheduledSubmissions;
  return ['EmailSubmission/get', { accountId: ACCOUNT_ID, state: nextState(), list, notFound: [] }, callId];
}

function handleQuotaGet(_args: MethodArgs, callId: string): MethodResult {
  // mirroring Stalwart: resourceType "octets", scope "account"
  return ['Quota/get', { accountId: ACCOUNT_ID, state: nextState(), list: [{ id: 'quota-1', resourceType: 'octets', scope: 'account', types: ['Email', 'SieveScript'], used: 52428800, hardLimit: 1073741824 }], notFound: [] }, callId];
}

function handleVacationResponseGet(_args: MethodArgs, callId: string): MethodResult {
  return ['VacationResponse/get', { accountId: ACCOUNT_ID, state: nextState(), list: [{ id: 'vacation-1', isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null }], notFound: [] }, callId];
}

function handleContactCardGet(args: MethodArgs, callId: string): MethodResult {
  const ids = args.ids as string[] | undefined;
  const list = ids ? contacts.filter((c) => ids.includes(c.id)) : contacts;
  return ['ContactCard/get', { accountId: ACCOUNT_ID, state: nextState(), list, notFound: [] }, callId];
}

function handleAddressBookGet(_args: MethodArgs, callId: string): MethodResult {
  return ['AddressBook/get', { accountId: ACCOUNT_ID, state: nextState(), list: addressBooks, notFound: [] }, callId];
}

function handleAddressBookSet(args: MethodArgs, callId: string): MethodResult {
  const created: Record<string, unknown> = {};
  const updated: Record<string, unknown> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, unknown> = {};

  if (args.create) {
    for (const [tempId, data] of Object.entries(args.create as Record<string, Record<string, unknown>>)) {
      const newId = `ab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const book = { isDefault: false, ...data, id: newId, name: String(data.name ?? 'Untitled') };
      addressBooks.push(book);
      created[tempId] = { id: newId, isDefault: book.isDefault };
    }
  }

  if (args.update) {
    for (const [id, patches] of Object.entries(args.update as Record<string, Record<string, unknown>>)) {
      const idx = addressBooks.findIndex(b => b.id === id);
      if (idx !== -1) {
        addressBooks[idx] = { ...addressBooks[idx], ...patches };
        updated[id] = null;
      }
    }
  }

  if (args.destroy) {
    for (const id of args.destroy as string[]) {
      const idx = addressBooks.findIndex(b => b.id === id);
      if (idx === -1) continue;
      if (addressBooks[idx].isDefault) {
        notDestroyed[id] = { type: 'forbidden', description: 'Cannot destroy the default address book' };
        continue;
      }
      addressBooks.splice(idx, 1);
      // Drop the book from every card, and the card itself once it belongs to none.
      for (let i = contacts.length - 1; i >= 0; i--) {
        const bookIds = contacts[i].addressBookIds as unknown as Record<string, boolean> | undefined;
        if (!bookIds?.[id]) continue;
        const remaining = { ...bookIds };
        delete remaining[id];
        if (Object.keys(remaining).length === 0) contacts.splice(i, 1);
        else contacts[i] = { ...contacts[i], addressBookIds: remaining } as unknown as typeof contacts[number];
      }
      destroyed.push(id);
    }
  }

  return ['AddressBook/set', {
    accountId: ACCOUNT_ID,
    oldState: nextState(),
    newState: nextState(),
    created: Object.keys(created).length > 0 ? created : null,
    updated: Object.keys(updated).length > 0 ? updated : null,
    destroyed: destroyed.length > 0 ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
  }, callId];
}

function handleCalendarGet(_args: MethodArgs, callId: string): MethodResult {
  return ['Calendar/get', { accountId: ACCOUNT_ID, state: nextState(), list: mockCalendars, notFound: [] }, callId];
}

function handleCalendarEventGet(args: MethodArgs, callId: string): MethodResult {
  const ids = args.ids as string[] | undefined;
  const list = ids ? calendarEvents.filter((e) => ids.includes(e.id)) : calendarEvents;
  return ['CalendarEvent/get', { accountId: ACCOUNT_ID, state: nextState(), list, notFound: [] }, callId];
}

function handleCalendarEventQuery(args: MethodArgs, callId: string): MethodResult {
  const filter = args.filter as Record<string, unknown> | undefined;
  let filtered = [...calendarEvents];
  if (filter?.inCalendars) {
    const calIds = filter.inCalendars as string[];
    filtered = filtered.filter((e) => calIds.some((cid) => (e.calendarIds as Record<string, boolean>)[cid]));
  }
  const ids = filtered.map((e) => e.id);
  return ['CalendarEvent/query', { accountId: ACCOUNT_ID, queryState: nextState(), ids, total: ids.length, position: 0, canCalculateChanges: false }, callId];
}

function handleSieveScriptGet(_args: MethodArgs, callId: string): MethodResult {
  return ['SieveScript/get', { accountId: ACCOUNT_ID, state: nextState(), list: [], notFound: [] }, callId];
}

function handlePushSubscriptionGet(args: MethodArgs, callId: string): MethodResult {
  const ids = Array.isArray(args.ids) ? args.ids as string[] : null;
  const selected = ids
    ? pushSubscriptions.filter((subscription) => ids.includes(subscription.id))
    : pushSubscriptions;
  const foundIds = new Set(selected.map((subscription) => subscription.id));

  return ['PushSubscription/get', {
    state: nextState(),
    list: selected.map(({ id, deviceClientId, expires, types }) => ({
      id,
      deviceClientId,
      expires,
      types,
    })),
    notFound: ids?.filter((id) => !foundIds.has(id)) ?? [],
  }, callId];
}

async function handlePushSubscriptionSet(args: MethodArgs, callId: string): Promise<MethodResult> {
  const created: Record<string, { id: string; expires: string | null; types: string[] | null }> = {};
  const notCreated: Record<string, { type: string; description: string }> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, { type: string; description: string }> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, { type: string }> = {};

  const create = args.create as Record<string, Record<string, unknown>> | undefined;
  if (create) {
    for (const [creationId, data] of Object.entries(create)) {
      try {
        const url = new URL(String(data.url ?? ''));
        const allowedOrigin = new URL(
          process.env.NEXT_PUBLIC_PUSH_RELAY_URL || DEFAULT_PUSH_RELAY_ORIGIN,
        ).origin;
        if (url.origin !== allowedOrigin || !url.pathname.startsWith('/api/push/jmap/')) {
          throw new Error('The dev mock only sends verification to the configured push relay');
        }

        const id = `push-${crypto.randomUUID()}`;
        const verificationCode = crypto.randomUUID().replace(/-/g, '');
        const subscription: MockPushSubscription = {
          id,
          deviceClientId: String(data.deviceClientId ?? ''),
          expires: typeof data.expires === 'string' ? data.expires : null,
          types: Array.isArray(data.types) ? data.types as string[] : null,
          expectedVerificationCode: verificationCode,
          verified: false,
        };

        const verificationResponse = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            '@type': 'PushVerification',
            pushSubscriptionId: id,
            verificationCode,
          }),
        });
        if (!verificationResponse.ok) {
          throw new Error(`Push relay rejected verification (${verificationResponse.status})`);
        }

        pushSubscriptions.push(subscription);
        created[creationId] = {
          id,
          expires: subscription.expires,
          types: subscription.types,
        };
      } catch (error) {
        notCreated[creationId] = {
          type: 'invalidProperties',
          description: error instanceof Error ? error.message : 'Invalid push subscription',
        };
      }
    }
  }

  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  if (update) {
    for (const [id, patch] of Object.entries(update)) {
      const subscription = pushSubscriptions.find((candidate) => candidate.id === id);
      if (!subscription) {
        notUpdated[id] = { type: 'notFound', description: 'Push subscription not found' };
        continue;
      }
      if (
        typeof patch.verificationCode === 'string'
        && patch.verificationCode !== subscription.expectedVerificationCode
      ) {
        notUpdated[id] = { type: 'invalidProperties', description: 'Invalid verification code' };
        continue;
      }
      if (typeof patch.verificationCode === 'string') subscription.verified = true;
      if (typeof patch.expires === 'string') subscription.expires = patch.expires;
      if (Array.isArray(patch.types)) subscription.types = patch.types as string[];
      updated[id] = null;
    }
  }

  if (Array.isArray(args.destroy)) {
    for (const id of args.destroy as string[]) {
      const index = pushSubscriptions.findIndex((subscription) => subscription.id === id);
      if (index === -1) {
        notDestroyed[id] = { type: 'notFound' };
        continue;
      }
      pushSubscriptions.splice(index, 1);
      destroyed.push(id);
    }
  }

  return ['PushSubscription/set', {
    created,
    notCreated,
    updated,
    notUpdated,
    destroyed,
    notDestroyed,
  }, callId];
}

// Catch-all for unknown methods
function handleUnknown(method: string, _args: MethodArgs, callId: string): MethodResult {
  return ['error', { type: 'unknownMethod', description: `Mock server does not implement ${method}` }, callId];
}

const METHOD_HANDLERS: Record<string, MethodHandler> = {
  'Core/echo': handleCoreEcho,
  'Mailbox/get': handleMailboxGet,
  'Mailbox/set': handleMailboxSet,
  'Email/query': handleEmailQuery,
  'Email/get': handleEmailGet,
  'Email/set': handleEmailSet,
  'Email/changes': (_args, callId) => ['Email/changes', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), hasMoreChanges: false, created: [], updated: [], destroyed: [] }, callId],
  'Thread/get': handleThreadGet,
  'Identity/get': handleIdentityGet,
  'Identity/set': handleIdentitySet,
  'EmailSubmission/set': handleEmailSubmissionSet,
  'EmailSubmission/query': handleEmailSubmissionQuery,
  'EmailSubmission/get': handleEmailSubmissionGet,
  'Quota/get': handleQuotaGet,
  'VacationResponse/get': handleVacationResponseGet,
  'VacationResponse/set': (_args, callId) => ['VacationResponse/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), updated: { 'vacation-1': null } }, callId],
  'ContactCard/get': handleContactCardGet,
  'ContactCard/set': (args, callId) => {
    const created: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const destroyed: string[] = [];

    if (args.create) {
      for (const [tempId, data] of Object.entries(args.create as Record<string, Record<string, unknown>>)) {
        const newId = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const newUid = `urn:uuid:${crypto.randomUUID()}`;
        const newContact = { id: newId, uid: newUid, ...data, addressBookIds: data.addressBookIds || { 'ab-1': true } };
        contacts.push(newContact as typeof contacts[number]);
        created[tempId] = { id: newId, uid: newUid };
      }
    }

    if (args.update) {
      for (const [id, patches] of Object.entries(args.update as Record<string, Record<string, unknown>>)) {
        const idx = contacts.findIndex(c => c.id === id);
        if (idx !== -1) {
          contacts[idx] = { ...contacts[idx], ...patches } as typeof contacts[number];
          updated[id] = null;
        }
      }
    }

    if (args.destroy) {
      for (const id of args.destroy as string[]) {
        const idx = contacts.findIndex(c => c.id === id);
        if (idx !== -1) {
          contacts.splice(idx, 1);
          destroyed.push(id);
        }
      }
    }

    return ['ContactCard/set', {
      accountId: ACCOUNT_ID,
      oldState: nextState(),
      newState: nextState(),
      created: Object.keys(created).length > 0 ? created : null,
      updated: Object.keys(updated).length > 0 ? updated : null,
      destroyed: destroyed.length > 0 ? destroyed : null,
    }, callId];
  },
  'ContactCard/query': (_args, callId) => ['ContactCard/query', { accountId: ACCOUNT_ID, queryState: nextState(), ids: contacts.map(c => c.id), total: contacts.length, position: 0 }, callId],
  'AddressBook/get': handleAddressBookGet,
  'AddressBook/set': handleAddressBookSet,
  'Calendar/get': handleCalendarGet,
  'CalendarEvent/get': handleCalendarEventGet,
  'CalendarEvent/query': handleCalendarEventQuery,
  'CalendarEvent/set': (_args, callId) => ['CalendarEvent/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created: null, updated: null, destroyed: null }, callId],
  'SieveScript/get': handleSieveScriptGet,
  'SieveScript/set': (_args, callId) => ['SieveScript/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created: null, updated: null, destroyed: null }, callId],
  'PushSubscription/get': handlePushSubscriptionGet,
  'PushSubscription/set': handlePushSubscriptionSet,
};

// ---------------------------------------------------------------------------
// Resolve back-references between method calls
// ---------------------------------------------------------------------------

function resolveBackReferences(
  methodCalls: Array<[string, MethodArgs, string]>,
  responses: MethodResult[],
): Array<[string, MethodArgs, string]> {
  return methodCalls.map((call) => {
    const [method, args, callId] = call;
    const resolved = { ...args };

    // Handle #ids back-reference (used by Email/get after Email/query)
    if (resolved['#ids']) {
      const ref = resolved['#ids'] as { resultOf: string; name: string; path: string };
      const refResponse = responses.find((r) => r[2] === ref.resultOf && r[0] === ref.name);
      if (refResponse) {
        const path = ref.path.replace(/^\//, '');
        resolved.ids = refResponse[1][path] as string[];
      }
      delete resolved['#ids'];
    }

    return [method, resolved, callId] as [string, MethodArgs, string];
  });
}

// ---------------------------------------------------------------------------
// Request limits
// ---------------------------------------------------------------------------

// Stalwart's defaults. Too many method calls fails the request whole
// (RFC 8620 §3.6.1), an over-sized /get or /set fails that call
// (`requestTooLarge`, §5.1 and §5.3). The mock enforces what it advertises so a
// client that sends an unsplit batch fails here the way it fails in production.
const MAX_CALLS_IN_REQUEST = 16;
const MAX_OBJECTS_IN_GET = 500;
const MAX_OBJECTS_IN_SET = 500;

/** Objects a /set call touches, across all three of its maps (RFC 8620 §5.3). */
function setObjectCount(args: MethodArgs): number {
  const size = (value: unknown) => (Array.isArray(value) ? value.length : Object.keys(value || {}).length);
  return size(args.create) + size(args.update) + size(args.destroy);
}

/** The method-level error a server returns for an over-sized /get or /set. */
function tooLargeFor(method: string, args: MethodArgs, callId: string): MethodResult | null {
  if (method.endsWith('/get') && Array.isArray(args.ids) && args.ids.length > MAX_OBJECTS_IN_GET) {
    return ['error', { type: 'requestTooLarge', description: `More than ${MAX_OBJECTS_IN_GET} ids in ${method}` }, callId];
  }
  if (method.endsWith('/set') && setObjectCount(args) > MAX_OBJECTS_IN_SET) {
    return ['error', { type: 'requestTooLarge', description: `More than ${MAX_OBJECTS_IN_SET} objects in ${method}` }, callId];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function isDevMockEnabled(): boolean {
  return process.env.DEV_MOCK_JMAP === 'true';
}

function getBaseUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const host = request.headers.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!isDevMockEnabled()) {
    return NextResponse.json({ error: 'Mock JMAP server is disabled' }, { status: 404 });
  }

  const { path } = await params;
  const joined = path.join('/');

  // Session endpoint: /.well-known/jmap
  if (joined === '.well-known/jmap') {
    const base = getBaseUrl(request);
    return NextResponse.json({
      capabilities: {
        'urn:ietf:params:jmap:core': {
          maxSizeUpload: 50000000,
          maxConcurrentUpload: 4,
          maxSizeRequest: 10000000,
          maxConcurrentRequests: 4,
          maxCallsInRequest: MAX_CALLS_IN_REQUEST,
          maxObjectsInGet: MAX_OBJECTS_IN_GET,
          maxObjectsInSet: MAX_OBJECTS_IN_SET,
          collationAlgorithms: ['i;ascii-casemap', 'i;ascii-numeric', 'i;unicode-casemap'],
        },
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:submission': {},
        'urn:ietf:params:jmap:quota': {},
        'urn:ietf:params:jmap:vacationresponse': {},
        'urn:ietf:params:jmap:contacts': {},
        'urn:ietf:params:jmap:calendars': {},
        'urn:ietf:params:jmap:sieve': {},
      },
      accounts: {
        [ACCOUNT_ID]: {
          name: 'Dev User',
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
            'urn:ietf:params:jmap:submission': { maxDelayedSend: 2592000, submissionExtensions: { FUTURERELEASE: true } },
            'urn:ietf:params:jmap:quota': {},
            'urn:ietf:params:jmap:vacationresponse': {},
            'urn:ietf:params:jmap:contacts': {},
            'urn:ietf:params:jmap:calendars': {},
            'urn:ietf:params:jmap:sieve': {},
          },
        },
      },
      primaryAccounts: {
        'urn:ietf:params:jmap:mail': ACCOUNT_ID,
        'urn:ietf:params:jmap:submission': ACCOUNT_ID,
        'urn:ietf:params:jmap:quota': ACCOUNT_ID,
        'urn:ietf:params:jmap:vacationresponse': ACCOUNT_ID,
        'urn:ietf:params:jmap:contacts': ACCOUNT_ID,
        'urn:ietf:params:jmap:calendars': ACCOUNT_ID,
        'urn:ietf:params:jmap:sieve': ACCOUNT_ID,
      },
      username: 'dev@localhost',
      apiUrl: `${base}/api/dev-jmap/api`,
      downloadUrl: `${base}/api/dev-jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${base}/api/dev-jmap/upload/{accountId}/`,
      eventSourceUrl: `${base}/api/dev-jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
      state: 'mock-session-state-1',
    });
  }

  // Download endpoint: /download/{accountId}/{blobId}/{name}
  if (joined.startsWith('download/')) {
    const segments = joined.split('/');
    // segments: ['download', accountId, blobId, name]
    const blobId = segments[2] || 'unknown';
    const name = decodeURIComponent(segments[3] || 'attachment');
    const accept = new URL(request.url).searchParams.get('accept') || 'application/octet-stream';

    // Find matching attachment across all emails
    let attachmentData: { name: string; type: string; size: number } | undefined;
    for (const email of emails) {
      const att = email.attachments?.find(a => a.blobId === blobId);
      if (att) {
        attachmentData = att;
        break;
      }
    }

    // Generate placeholder content for the blob
    const contentType = attachmentData?.type || accept;
    const fileName = attachmentData?.name || name;
    const body = `[Mock file content for blob ${blobId}: ${fileName}]`;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  }

  // EventSource endpoint: /eventsource
  if (joined === 'eventsource') {
    const ping = parseInt(new URL(request.url).searchParams.get('ping') || '0', 10);
    const pingInterval = ping > 0 ? ping : 30;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send initial state event
        const stateEvent = JSON.stringify({
          '@type': 'StateChange',
          changed: {
            [ACCOUNT_ID]: {
              'Email': nextState(),
              'Mailbox': nextState(),
              'Thread': nextState(),
            },
          },
        });
        controller.enqueue(encoder.encode(`event: state\ndata: ${stateEvent}\n\n`));

        // Send periodic pings to keep the connection alive
        const interval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ interval: pingInterval })}\n\n`));
          } catch {
            clearInterval(interval);
          }
        }, pingInterval * 1000);

        // Close after 5 minutes to prevent indefinite connections in dev
        setTimeout(() => {
          clearInterval(interval);
          try { controller.close(); } catch { /* already closed */ }
        }, 5 * 60 * 1000);
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!isDevMockEnabled()) {
    return NextResponse.json({ error: 'Mock JMAP server is disabled' }, { status: 404 });
  }

  const { path } = await params;
  const joined = path.join('/');

  // JMAP API endpoint
  if (joined === 'api') {
    try {
      const body = await request.json();
      const methodCalls = body.methodCalls as Array<[string, MethodArgs, string]>;

      if (!methodCalls || !Array.isArray(methodCalls)) {
        return NextResponse.json({ error: 'Invalid request: missing methodCalls' }, { status: 400 });
      }

      if (methodCalls.length > MAX_CALLS_IN_REQUEST) {
        return NextResponse.json({
          type: 'urn:ietf:params:jmap:error:limit',
          status: 400,
          limit: 'maxCallsInRequest',
          detail: `This request contains ${methodCalls.length} method calls, the maximum is ${MAX_CALLS_IN_REQUEST}.`,
        }, { status: 400 });
      }

      const responses: MethodResult[] = [];

      // Process method calls sequentially (to support back-references)
      const resolved = resolveBackReferences(methodCalls, responses);
      for (let i = 0; i < methodCalls.length; i++) {
        const [method, , callId] = methodCalls[i];
        // Use resolved args if available, otherwise original
        const args = i < resolved.length ? resolved[i][1] : methodCalls[i][1];

        const tooLarge = tooLargeFor(method, args, callId);
        const handler = METHOD_HANDLERS[method];
        if (tooLarge) {
          responses.push(tooLarge);
        } else if (handler) {
          const result = await handler(args, callId);
          responses.push(result);
        } else {
          responses.push(handleUnknown(method, args, callId));
        }

        // Re-resolve remaining calls with new responses
        if (i < methodCalls.length - 1) {
          const remaining = methodCalls.slice(i + 1);
          const reResolved = resolveBackReferences(remaining, responses);
          for (let j = 0; j < reResolved.length; j++) {
            resolved[i + 1 + j] = reResolved[j];
          }
        }
      }

      return NextResponse.json({ methodResponses: responses });
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
  }

  // Upload endpoint (accept but return a fake blob)
  if (joined.startsWith('upload/')) {
    return NextResponse.json({
      accountId: ACCOUNT_ID,
      blobId: `blob-upload-${Date.now()}`,
      type: request.headers.get('content-type') || 'application/octet-stream',
      size: Number(request.headers.get('content-length') || 0),
    });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
