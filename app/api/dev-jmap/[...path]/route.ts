import { NextRequest, NextResponse } from 'next/server';

/**
 * Mock JMAP server for local development.
 *
 * Enabled only when DEV_MOCK_JMAP=true. Provides realistic dummy data
 * so the UI can be developed without a real JMAP mail server.
 *
 * Accepts any username/password - no real authentication.
 */

const ACCOUNT_ID = 'dev-account-001';

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
    preview: 'Hallo! This is a sample email to help you get started with the Bulwark Webmail development environment.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-001', size: 280, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-002', size: 420, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hallo!\n\nThis is a sample email to help you get started with the Bulwark Webmail development environment.\n\nFeel free to explore the UI - all data here is mock data.\n\nBeste Grüße,\nSophie' },
      p2: { value: '<p>Hallo!</p><p>This is a sample email to help you get started with the <strong>Bulwark Webmail</strong> development environment.</p><p>Feel free to explore the UI - all data here is mock data.</p><p>Beste Grüße,<br>Sophie</p>' },
    },
  },
  {
    id: 'email-002', threadId: 'thread-002', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$label:blue': true }, size: 5100, receivedAt: daysAgo(1),
    from: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Karel de Vries', email: 'karel@devries.example' }],
    subject: 'Project Update - Q1 Review',
    preview: 'Salut team, I wanted to share the latest project numbers. We are on track to meet our targets for Q1.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-003', size: 640, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-004', size: 820, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Salut team,\n\nI wanted to share the latest project numbers. We are on track to meet our targets for Q1.\n\nKey highlights:\n- Revenue up 12%\n- New signups increased by 8%\n- Customer satisfaction at 94%\n\nLet me know if you have questions.\n\nCordialement,\nPierre' },
      p2: { value: '<p>Salut team,</p><p>I wanted to share the latest project numbers. We are on track to meet our targets for Q1.</p><ul><li>Revenue up 12%</li><li>New signups increased by 8%</li><li>Customer satisfaction at 94%</li></ul><p>Let me know if you have questions.</p><p>Cordialement,<br>Pierre</p>' },
    },
    attachments: [
      { partId: 'att1', blobId: 'blob-att-001', size: 24500, name: 'Q1-Bericht.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-003', threadId: 'thread-003', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 3100, receivedAt: daysAgo(2),
    from: [{ name: 'Chiara Rossi', email: 'chiara@rossi.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Pranzo domani?',
    preview: 'Ciao! Are you free for lunch tomorrow? I know a great trattoria near the Herengracht.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-005', size: 180, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-006', size: 260, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Ciao!\n\nAre you free for lunch tomorrow? I know a great trattoria near the Herengracht. They do an amazing risotto ai funghi porcini.\n\nFammi sapere!\nChiara' },
      p2: { value: '<p>Ciao!</p><p>Are you free for lunch tomorrow? I know a great trattoria near the Herengracht. They do an amazing risotto ai funghi porcini.</p><p>Fammi sapere!<br>Chiara</p>' },
    },
  },
  {
    id: 'email-004', threadId: 'thread-004', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:red': true }, size: 6200, receivedAt: daysAgo(0),
    from: [{ name: 'GitHub Notifications', email: 'notifications@github.com' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[bulwark-webmail] New issue: Add dark mode toggle (#42)',
    preview: 'A new issue has been opened by @contributor. It would be great to have a dark mode toggle in the settings panel.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-007', size: 350, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-008', size: 500, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'A new issue has been opened by @contributor.\n\nTitle: Add dark mode toggle\n\nIt would be great to have a dark mode toggle in the settings panel. Currently users have to rely on system preferences.\n\n-\nReply to this email directly or view it on GitHub.' },
      p2: { value: '<p>A new issue has been opened by <strong>@contributor</strong>.</p><h3>Add dark mode toggle</h3><p>It would be great to have a dark mode toggle in the settings panel. Currently users have to rely on system preferences.</p><hr><p><em>Reply to this email directly or view it on GitHub.</em></p>' },
    },
  },
  {
    id: 'email-005', threadId: 'thread-005', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2800, receivedAt: daysAgo(4),
    from: [{ name: 'Newsletter', email: 'news@techdigest.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Your Weekly Tech Digest',
    preview: 'This week in tech: new JavaScript runtime benchmarks, WebAssembly reaches 3.0, and more.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-009', size: 900, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-010', size: 1400, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'This week in tech:\n\n1. New JavaScript runtime benchmarks show 30% improvement\n2. WebAssembly reaches version 3.0\n3. CSS container queries gain full browser support\n4. TypeScript 6.0 release candidate announced\n\nRead more at techdigest.example' },
      p2: { value: '<h2>Your Weekly Tech Digest</h2><ol><li>New JavaScript runtime benchmarks show 30% improvement</li><li>WebAssembly reaches version 3.0</li><li>CSS container queries gain full browser support</li><li>TypeScript 6.0 release candidate announced</li></ol><p><a href="#">Read more at techdigest.example</a></p>' },
    },
  },
  // Newsletter with full HTML
  {
    id: 'email-013', threadId: 'thread-012', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:purple': true }, size: 18200, receivedAt: daysAgo(0),
    from: [{ name: 'Launchpad Weekly', email: 'hello@launchpad.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Launchpad Weekly #47 - The future of the open web',
    preview: 'This week: WebAssembly Components hit 1.0, a deep dive into privacy-first analytics, and 5 tools we can\'t stop using.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-020', size: 1200, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-021', size: 16000, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'LAUNCHPAD WEEKLY #47\nThe future of the open web\n\nWebAssembly Components hit 1.0\nThe Component Model spec has reached 1.0, unlocking language-agnostic modules that run anywhere.\n\nDeep dive: Privacy-first analytics\nCookie banners are on their way out. We explore the next generation of analytics tools that respect user privacy by design.\n\n5 tools we can\'t stop using\n1. Vite 7 - lightning-fast builds\n2. Biome - unified lint + format\n3. Deno 4 - batteries included runtime\n4. TailwindCSS 4 - zero config styling\n5. Playwright - end-to-end testing\n\nYou received this because you subscribed at launchpad.example.\nUnsubscribe: https://launchpad.example/unsubscribe' },
      p2: { value: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head><body style="margin:0;padding:0;background-color:#1a1a2e;font-family:\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#e0e0e0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a2e;"><tr><td align="center" style="padding:40px 16px;"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;"><tr><td style="padding:24px 32px;text-align:center;"><span style="font-size:20px;font-weight:700;color:#a78bfa;letter-spacing:2px;">&#9670; LAUNCHPAD WEEKLY</span><br><span style="font-size:13px;color:#9ca3af;letter-spacing:1px;">ISSUE #47 &bull; MARCH 2026</span></td></tr><tr><td style="background:linear-gradient(135deg,#4c1d95 0%,#7c3aed 50%,#2563eb 100%);border-radius:16px 16px 0 0;padding:48px 40px 40px 40px;text-align:center;"><h1 style="margin:0 0 12px 0;font-size:32px;font-weight:800;color:#ffffff;line-height:1.2;">The future of the open web</h1><p style="margin:0;font-size:16px;color:#e0e7ff;line-height:1.5;">WebAssembly Components hit 1.0, privacy-first analytics take center stage, and 5 tools we can&#8217;t stop using.</p></td></tr><tr><td style="background-color:#16213e;padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:36px 40px 32px 40px;border-bottom:1px solid #1e3a5f;"><span style="display:inline-block;background-color:#7c3aed;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:1px;margin-bottom:12px;">FEATURED</span><h2 style="margin:12px 0 8px 0;font-size:22px;font-weight:700;color:#f1f5f9;">WebAssembly Components hit 1.0</h2><p style="margin:0 0 16px 0;font-size:15px;color:#94a3b8;line-height:1.6;">The Component Model specification has officially reached 1.0, unlocking language-agnostic modules that compose and run anywhere&#8202;&#8212;&#8202;from the browser to the edge. This is a watershed moment for portable computing.</p><a href="#" style="display:inline-block;background-color:#7c3aed;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;">Read the deep dive &rarr;</a></td></tr><tr><td style="padding:32px 40px;border-bottom:1px solid #1e3a5f;"><span style="display:inline-block;background-color:#2563eb;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:1px;margin-bottom:12px;">ANALYSIS</span><h2 style="margin:12px 0 8px 0;font-size:22px;font-weight:700;color:#f1f5f9;">Deep dive: Privacy-first analytics</h2><p style="margin:0 0 16px 0;font-size:15px;color:#94a3b8;line-height:1.6;">Cookie banners are on their way out. We explore the next generation of analytics platforms that respect user privacy by design&#8202;&#8212;&#8202;no consent dialogs required. From server-side aggregation to differential privacy, the landscape is shifting fast.</p><a href="#" style="display:inline-block;border:1px solid #7c3aed;color:#a78bfa;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:8px;">Explore the guide &rarr;</a></td></tr><tr><td style="padding:32px 40px;"><span style="display:inline-block;background-color:#0d9488;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:1px;margin-bottom:12px;">TOOLBOX</span><h2 style="margin:12px 0 16px 0;font-size:22px;font-weight:700;color:#f1f5f9;">5 tools we can&#8217;t stop using</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:12px 16px;background-color:#1e293b;border-radius:10px;margin-bottom:8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="width:36px;vertical-align:top;"><span style="font-size:20px;font-weight:800;color:#7c3aed;">1</span></td><td><span style="font-size:15px;font-weight:600;color:#f1f5f9;">Vite 7</span><br><span style="font-size:13px;color:#94a3b8;">Lightning-fast builds with zero-config ESM support.</span></td></tr></table></td></tr><tr><td style="height:8px;"></td></tr><tr><td style="padding:12px 16px;background-color:#1e293b;border-radius:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="width:36px;vertical-align:top;"><span style="font-size:20px;font-weight:800;color:#7c3aed;">2</span></td><td><span style="font-size:15px;font-weight:600;color:#f1f5f9;">Biome</span><br><span style="font-size:13px;color:#94a3b8;">Unified linting and formatting in a single blazing-fast tool.</span></td></tr></table></td></tr><tr><td style="height:8px;"></td></tr><tr><td style="padding:12px 16px;background-color:#1e293b;border-radius:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="width:36px;vertical-align:top;"><span style="font-size:20px;font-weight:800;color:#7c3aed;">3</span></td><td><span style="font-size:15px;font-weight:600;color:#f1f5f9;">Deno 4</span><br><span style="font-size:13px;color:#94a3b8;">Batteries-included runtime with native TypeScript &amp; npm compat.</span></td></tr></table></td></tr><tr><td style="height:8px;"></td></tr><tr><td style="padding:12px 16px;background-color:#1e293b;border-radius:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="width:36px;vertical-align:top;"><span style="font-size:20px;font-weight:800;color:#7c3aed;">4</span></td><td><span style="font-size:15px;font-weight:600;color:#f1f5f9;">TailwindCSS 4</span><br><span style="font-size:13px;color:#94a3b8;">Zero-config utility-first CSS that just works.</span></td></tr></table></td></tr><tr><td style="height:8px;"></td></tr><tr><td style="padding:12px 16px;background-color:#1e293b;border-radius:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="width:36px;vertical-align:top;"><span style="font-size:20px;font-weight:800;color:#7c3aed;">5</span></td><td><span style="font-size:15px;font-weight:600;color:#f1f5f9;">Playwright</span><br><span style="font-size:13px;color:#94a3b8;">Reliable end-to-end testing across every browser.</span></td></tr></table></td></tr></table></td></tr></table></td></tr><tr><td style="background-color:#0f172a;border-radius:0 0 16px 16px;padding:28px 40px;text-align:center;border-top:1px solid #1e3a5f;"><p style="margin:0 0 6px 0;font-size:13px;color:#64748b;">You received this because you subscribed at <a href="#" style="color:#7c3aed;text-decoration:none;">launchpad.example</a></p><p style="margin:0;font-size:13px;color:#64748b;"><a href="#" style="color:#7c3aed;text-decoration:none;">Unsubscribe</a> &bull; <a href="#" style="color:#7c3aed;text-decoration:none;">Manage preferences</a> &bull; <a href="#" style="color:#7c3aed;text-decoration:none;">View in browser</a></p></td></tr></table></td></tr></table></body></html>' },
    },
  },
  // --- Additional inbox emails ---
  {
    id: 'email-014', threadId: 'thread-013', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3400, receivedAt: hoursAgo(2),
    from: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Sprint planning - next week priorities',
    preview: 'Hej team, here are the priorities for next sprint. Please review before our planning meeting tomorrow.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-030', size: 450, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-031', size: 600, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hej team,\n\nHere are the priorities for next sprint:\n\n1. Finish JMAP calendar integration\n2. Fix email threading bug (#187)\n3. Implement contact group management\n4. Performance optimization for large mailboxes\n5. Accessibility audit follow-ups\n\nPlease review before our planning meeting tomorrow at 10:00.\n\nTack,\nLars' },
      p2: { value: '<p>Hej team,</p><p>Here are the priorities for next sprint:</p><ol><li>Finish JMAP calendar integration</li><li>Fix email threading bug (#187)</li><li>Implement contact group management</li><li>Performance optimization for large mailboxes</li><li>Accessibility audit follow-ups</li></ol><p>Please review before our planning meeting tomorrow at 10:00.</p><p>Tack,<br>Lars</p>' },
    },
  },
  {
    id: 'email-015', threadId: 'thread-014', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 5800, receivedAt: hoursAgo(5),
    from: [{ name: 'Booking.com', email: 'automated@booking.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Prenotazione Confermata - Lake Como, Mar 28–30',
    preview: 'Your reservation has been confirmed. Check-in: March 28, 2026. Check-out: March 30, 2026.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-032', size: 500, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-033', size: 900, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Your reservation has been confirmed!\n\nProperty: Villa sul Lago, Bellagio, Lake Como\nCheck-in: March 28, 2026 (15:00)\nCheck-out: March 30, 2026 (11:00)\nGuests: 2\nTotal: €385,00\n\nConfirmation code: EU42GDPR\n\nHouse rules and directions are in the attached PDF.' },
      p2: { value: '<h2>Prenotazione Confermata!</h2><p>Your reservation at <strong>Villa sul Lago, Bellagio, Lake Como</strong> is confirmed.</p><table><tr><td>Check-in</td><td>March 28, 2026 (15:00)</td></tr><tr><td>Check-out</td><td>March 30, 2026 (11:00)</td></tr><tr><td>Guests</td><td>2</td></tr><tr><td>Total</td><td>€385,00</td></tr></table><p>Confirmation code: <strong>EU42GDPR</strong></p>' },
    },
    attachments: [
      { partId: 'att2', blobId: 'blob-att-002', size: 18200, name: 'conferma-prenotazione.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-016', threadId: 'thread-015', mailboxIds: { 'mb-inbox': true }, keywords: { '$label:green': true }, size: 4100, receivedAt: hoursAgo(3),
    from: [{ name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Code review request: JMAP-342 contact import',
    preview: 'Salut, I just pushed the contact vCard import feature. Could you review when you get a chance?',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-034', size: 380, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-035', size: 520, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Salut,\n\nI just pushed the contact vCard import feature (JMAP-342). Could you review when you get a chance?\n\nPR: https://github.example/bulwark-webmail/pull/342\n\nKey changes:\n- New vCard parser with v3/v4 support\n- Batch import with progress indicator\n- Duplicate detection and merge UI\n- Unit tests for edge cases\n\nMerci d\'avance,\nÉlise' },
      p2: { value: '<p>Salut,</p><p>I just pushed the contact vCard import feature (<code>JMAP-342</code>). Could you review when you get a chance?</p><p>PR: <a href="#">bulwark-webmail/pull/342</a></p><h4>Key changes:</h4><ul><li>New vCard parser with v3/v4 support</li><li>Batch import with progress indicator</li><li>Duplicate detection and merge UI</li><li>Unit tests for edge cases</li></ul><p>Merci d\'avance,<br>Élise</p>' },
    },
  },
  {
    id: 'email-017', threadId: 'thread-016', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2900, receivedAt: daysAgo(1),
    from: [{ name: 'GitHub', email: 'noreply@github.com' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[GitHub] A new sign-in from Firefox on Linux',
    preview: 'We noticed a new sign-in to your account from Firefox on Linux. If this was you, no action is needed.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-036', size: 350, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hi dev,\n\nWe noticed a new sign-in to your GitHub account.\n\nBrowser: Firefox 128\nOS: Linux (Fedora)\nLocation: Amsterdam, NL\nIP: 42.42.42.42\nTime: March 10, 2026 at 14:15 CET\n\nIf this was you, no action is needed. Don\'t Panic.\n\nIf you don\'t recognize this activity, please review your security settings.\n\nGitHub Security' },
    },
  },
  {
    id: 'email-018', threadId: 'thread-017', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$label:orange': true }, size: 4700, receivedAt: daysAgo(1),
    from: [{ name: 'Hetzner Cloud', email: 'billing@hetzner.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Your Hetzner invoice is available - February 2026',
    preview: 'Your Hetzner Cloud invoice for February 2026 is now available. Total: €1.337,42.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-037', size: 400, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Guten Tag,\n\nYour Hetzner Cloud invoice for February 2026 is now available.\n\nKundennummer: DE-4242-1337\nBilling period: Feb 1 – Feb 28, 2026\nTotal charges: €1.337,42\n\nService breakdown:\n- CX41 Dedicated: €41,20\n- Storage Box: €11,30\n- Managed Database: €47,10\n- Load Balancer: €7,43\n- Floating IPs: €8,39\n\nView your full invoice at console.hetzner.example/billing' },
    },
    attachments: [
      { partId: 'att3', blobId: 'blob-att-003', size: 32100, name: 'Hetzner-Rechnung-Feb-2026.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-019', threadId: 'thread-018', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 3600, receivedAt: daysAgo(2),
    from: [{ name: 'Astrid van der Berg', email: 'astrid@berglabs.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }, { name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }], cc: [],
    subject: 'Meeting notes - API design review',
    preview: 'Here are the notes from today\'s API design review session. Key decisions: REST for public API, gRPC for internal services.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-038', size: 600, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-039', size: 800, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'Hoi allemaal,\n\nHere are the notes from today\'s API design review:\n\nDecisions:\n1. REST for public-facing APIs (OpenAPI 3.1 spec)\n2. gRPC for internal service communication\n3. GraphQL only for the dashboard BFF\n4. Rate limiting: 100 req/min for free tier, 1000 for pro\n\nAction items:\n- Dev: Draft OpenAPI spec by Friday\n- Lars: Set up gRPC proto repository\n- Astrid: Update architecture diagrams\n\nNext review: March 18, 2026\n\nGroetjes,\nAstrid' },
      p2: { value: '<p>Hoi allemaal,</p><p>Here are the notes from today\'s API design review:</p><h3>Decisions:</h3><ol><li>REST for public-facing APIs (OpenAPI 3.1 spec)</li><li>gRPC for internal service communication</li><li>GraphQL only for the dashboard BFF</li><li>Rate limiting: 100 req/min for free tier, 1000 for pro</li></ol><h3>Action items:</h3><ul><li><strong>Dev:</strong> Draft OpenAPI spec by Friday</li><li><strong>Lars:</strong> Set up gRPC proto repository</li><li><strong>Astrid:</strong> Update architecture diagrams</li></ul><p>Next review: March 18, 2026</p><p>Groetjes,<br>Astrid</p>' },
    },
  },
  {
    id: 'email-020', threadId: 'thread-019', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 5200, receivedAt: daysAgo(3),
    from: [{ name: 'Jacques Lefèvre', email: 'jacques@lefevre-avocats.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Re: Partnership agreement - feedback',
    preview: 'I reviewed the draft agreement. A few points need clarification around intellectual property clauses.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-040', size: 700, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Bonjour,\n\nI reviewed the draft partnership agreement. Overall it looks good, but a few points need clarification:\n\n1. Article 4.2 - IP ownership clause is ambiguous. Should specify that pre-existing IP remains with original owner.\n2. Article 7.1 - Non-compete period of 24 months may be too restrictive under EU law. Suggest 12 months.\n3. Article 9.3 - Liability cap should be tied to contract value, not a fixed amount.\n\nI\'ve marked up the document with detailed comments (attached).\n\nLet me know when you\'d like to discuss.\n\nBien cordialement,\nJacques Lefèvre\nLefèvre & Associés' },
    },
    attachments: [
      { partId: 'att4', blobId: 'blob-att-004', size: 45000, name: 'Contrat-de-Partenariat-Annoté.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ],
  },
  {
    id: 'email-021', threadId: 'thread-020', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2800, receivedAt: daysAgo(3),
    from: [{ name: 'Katrin Bauer', email: 'katrin.bauer@charite.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }, { name: 'Chiara Rossi', email: 'chiara@rossi.example' }],
    subject: 'Team outing - voting on activity',
    preview: 'Hey everyone! Time to vote on next month\'s team outing. Options: Biergarten, Eurovision watch party, or cooking class.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-041', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hallo zusammen!\n\nTime to vote on next month\'s team outing. Please reply with your preference:\n\nA) Biergarten evening + Bretzel buffet\nB) Eurovision watch party (with scorecards!)\nC) Cooking class (Italian cuisine - pasta fresca)\n\nVoting closes Friday. Most votes wins!\n\nKatrin' },
    },
  },
  {
    id: 'email-022', threadId: 'thread-021', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3200, receivedAt: hoursAgo(1),
    from: [{ name: 'GitHub Notifications', email: 'notifications@github.com' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[vcard-parser] PR merged: Add support for FBURL property (#89)',
    preview: 'Your pull request #89 has been merged into main. Thanks for contributing!',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-042', size: 280, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Your pull request has been merged.\n\nRepository: vcard-parser\nPR #89: Add support for FBURL property\nMerged by: @maintainer\nBranch: feature/fburl → main\n\nCommits merged:\n- feat: parse FBURL property from vCard 4.0\n- test: add FBURL round-trip tests\n- docs: update README with FBURL example\n\n-\nReply to this email directly or view it on GitHub.' },
    },
  },
  {
    id: 'email-023', threadId: 'thread-022', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3800, receivedAt: hoursAgo(4),
    from: [{ name: 'Support Team', email: 'support@saas-platform.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '[Ticket #4521] Escalation: API rate limit exceeded for enterprise account',
    preview: 'A customer reported hitting rate limits despite being on the enterprise plan. This has been escalated to engineering.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-043', size: 500, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hallo Dev,\n\nTicket #4521 has been escalated to engineering.\n\nCustomer: EuroTech GmbH (Enterprise plan)\nIssue: API rate limit exceeded\nImpact: Production integration failing intermittently\n\nDetails:\n- Customer is hitting the 1000 req/min limit\n- Their usage pattern shows bursts of 2000+ req/min during peak hours\n- They\'re requesting a temporary increase to 5000 req/min\n\nCan you review the rate limiting config and advise?\n\nPriority: High\nSLA: 4 hours\n\nDanke,\nSupport Team' },
    },
  },
  {
    id: 'email-024', threadId: 'thread-023', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 7200, receivedAt: daysAgo(5),
    from: [{ name: 'DEV Community', email: 'digest@dev.to.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'DEV Digest - Top posts this week',
    preview: 'This week\'s top posts: "Why I switched from React to Solid", "Building a CLI tool in Rust", and more.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-044', size: 800, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-045', size: 1200, type: 'text/html' }],
    bodyValues: {
      p1: { value: 'DEV Digest - Top posts this week\n\n1. "Why I switched from React to Solid" by @webdev - 342 reactions\n2. "Building a CLI tool in Rust from scratch" by @rustacean - 289 reactions\n3. "The state of CSS in 2026" by @cssmaster - 256 reactions\n4. "Microservices are dead, long live modular monoliths" by @architect - 234 reactions\n5. "A beginner\'s guide to WebAssembly Components" by @wasmdev - 198 reactions\n\nHappy coding!\nThe DEV Team' },
      p2: { value: '<h2>DEV Digest</h2><p>Top posts this week:</p><ol><li><strong>"Why I switched from React to Solid"</strong> - 342 reactions</li><li><strong>"Building a CLI tool in Rust from scratch"</strong> - 289 reactions</li><li><strong>"The state of CSS in 2026"</strong> - 256 reactions</li><li><strong>"Microservices are dead, long live modular monoliths"</strong> - 234 reactions</li><li><strong>"A beginner\'s guide to WebAssembly Components"</strong> - 198 reactions</li></ol><p>Happy coding!<br>The DEV Team</p>' },
    },
  },
  {
    id: 'email-025', threadId: 'thread-024', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true, $flagged: true, '$label:blue': true }, size: 4100, receivedAt: daysAgo(6),
    from: [{ name: 'Stripe Developer', email: 'developer-updates@stripe.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Action required: API v2023-10 deprecation on April 15, 2026',
    preview: 'Stripe API version 2023-10 will be deprecated on April 15, 2026. Please upgrade to v2025-01 before then.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-046', size: 550, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Important: API Deprecation Notice\n\nStripe API version 2023-10 will be deprecated on April 15, 2026.\n\nWhat you need to do:\n1. Review the migration guide: https://stripe.example/docs/upgrades\n2. Update your API version to 2025-01\n3. Test your integration in test mode\n4. Deploy changes before April 15\n\nBreaking changes in v2025-01:\n- Payment Intent confirmation flow updated\n- Webhook event structure changes\n- Deprecated parameters removed\n\nQuestions? Contact developer-support@stripe.example\n\nStripe Developer Relations' },
    },
  },
  {
    id: 'email-026', threadId: 'thread-013', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 2400, receivedAt: hoursAgo(1),
    from: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }],
    to: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    cc: [{ name: 'Dev User', email: 'dev@localhost' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Re: Sprint planning - next week priorities',
    preview: 'Looks good! I\'d also suggest we add the email signature editor to the list. I can take that one.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-047', size: 200, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Sieht gut aus! I\'d also suggest we add the email signature editor to the list. I can take that one.\n\nAlso, can we move the planning meeting to 10:30? I have a conflict at 10.\n\nSophie' },
    },
  },
  {
    id: 'email-040', threadId: 'thread-035', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 4500, receivedAt: hoursAgo(0.5),
    from: [{ name: 'Liam Ó Donaill', email: 'liam.odonaill@finanz.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }],
    cc: [{ name: 'Nils Andersson', email: 'nils@digitaal.example' }],
    subject: 'Q1 Budget Review - Meeting this Thursday',
    preview: 'Hi, let\'s meet Thursday at 14:00 to review the Q1 engineering budget. Please bring your team\'s actuals.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-062', size: 350, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Dia duit,\n\nLet\'s meet Thursday at 14:00 to review the Q1 engineering budget.\n\nAgenda:\n1. Actuals vs. forecast (see attached)\n2. Cloud infrastructure cost optimization\n3. Headcount planning for Q2\n4. Software license renewals\n\nPlease bring your team\'s actual spend numbers.\n\nMeeting room: Konferenzsaal B / Zoom link in calendar invite\n\nLiam' },
    },
    attachments: [
      { partId: 'att9', blobId: 'blob-att-009', size: 54000, name: 'Q1-Budget-Vorlage.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  },
  {
    id: 'email-041', threadId: 'thread-036', mailboxIds: { 'mb-inbox': true }, keywords: { $seen: true }, size: 2600, receivedAt: daysAgo(7),
    from: [{ name: 'María García', email: 'maria@garcia-design.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Updated brand guidelines and component library',
    preview: 'Hola! The new brand guidelines are finalized. I\'ve also updated the Figma component library.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-063', size: 350, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: '¡Hola!\n\nThe new brand guidelines are finalized. Key updates:\n\n- Primary color shifted to #7c3aed (from #6366f1)\n- New typography scale (Inter for body, Cal Sans for headings)\n- Updated icon set (Lucide → custom icon font)\n- Dark mode color tokens added\n\nI\'ve also updated the Figma component library. Link: figma.example/bulwark-webmail-v2\n\nBrand guidelines PDF attached.\n\nMaría' },
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
    preview: 'Hej! Haven\'t caught up in a while. Free for a fika next week? Tuesday or Wednesday work best for me.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-064', size: 150, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hej!\n\nHaven\'t caught up in a while. Free for a fika next week? Tuesday or Wednesday work best for me.\n\nThere\'s a great new café on the Prinsengracht I\'ve been wanting to try - they do a wonderful kanelbulle.\n\nNils' },
    },
  },
  {
    id: 'email-039', threadId: 'thread-034', mailboxIds: { 'mb-inbox': true }, keywords: {}, size: 3400, receivedAt: hoursAgo(0.25),
    from: [{ name: 'CI/CD Pipeline', email: 'ci@github.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '❌ Build failed: main - bulwark-webmail #1337',
    preview: 'Build #1337 on branch main failed. 2 test(s) failed in email-sanitization.test.ts.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-060', size: 450, type: 'text/plain' }],
    htmlBody: [{ partId: 'p2', blobId: 'blob-061', size: 600, type: 'text/html' }],
    bodyValues: {
      p1: { value: '❌ Build #1337 FAILED\n\nRepository: bulwark-webmail\nBranch: main\nCommit: a3f9c21 "fix: sanitize CSS in email body"\nTriggered by: @elise-moreau\n\nFailed tests:\n  ✗ email-sanitization.test.ts > should strip javascript: URLs\n  ✗ email-sanitization.test.ts > should handle nested style tags\n\nPassed: 247 | Failed: 2 | Skipped: 0\nDuration: 42.0s\n\nView full logs: https://github.example/bulwark-webmail/actions/runs/1337' },
      p2: { value: '<h3>❌ Build #1337 FAILED</h3><table><tr><td>Repository</td><td>bulwark-webmail</td></tr><tr><td>Branch</td><td><code>main</code></td></tr><tr><td>Commit</td><td><code>a3f9c21</code> "fix: sanitize CSS in email body"</td></tr></table><h4>Failed tests:</h4><ul><li>❌ <code>email-sanitization.test.ts</code> &gt; should strip javascript: URLs</li><li>❌ <code>email-sanitization.test.ts</code> &gt; should handle nested style tags</li></ul><p><strong>Passed: 247</strong> | <strong style="color:red">Failed: 2</strong> | Skipped: 0</p>' },
    },
  },
  // =====================================================================
  // SENT
  // =====================================================================
  {
    id: 'email-006', threadId: 'thread-003', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1800, receivedAt: daysAgo(2),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Chiara Rossi', email: 'chiara@rossi.example' }], cc: [],
    subject: 'Re: Pranzo domani?',
    preview: 'Perfetto! Let\'s meet at noon.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-011', size: 80, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Perfetto! Let\'s meet at noon by the Herengracht.\n\n- Dev User' },
    },
  },
  {
    id: 'email-007', threadId: 'thread-006', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 2200, receivedAt: daysAgo(3),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Pierre Dubois', email: 'pierre@dubois.example' }], cc: [],
    subject: 'Re: Project Update - Q1 Review',
    preview: 'Merci Pierre, the numbers look great. I\'ll prepare the board presentation.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-012', size: 150, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Merci Pierre, the numbers look great. I\'ll prepare the board presentation.\n\nCheers,\nDev User' },
    },
  },
  {
    id: 'email-008', threadId: 'thread-007', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 3100, receivedAt: daysAgo(5),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }], cc: [],
    subject: 'Design review feedback',
    preview: 'Hallo Sophie, I reviewed the new mockups and have a few suggestions.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-013', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hallo Sophie,\n\nI reviewed the new mockups and have a few suggestions:\n\n1. The sidebar could use more contrast\n2. Consider adding breadcrumbs to the settings page\n3. The compose button placement looks good\n\nOverall great work!\n\nDev User' },
    },
  },
  {
    id: 'email-027', threadId: 'thread-013', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1900, receivedAt: hoursAgo(0.5),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Lars Johansson', email: 'lars.johansson@fjord-systems.example' }],
    cc: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }, { name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }],
    subject: 'Re: Sprint planning - next week priorities',
    preview: 'Great suggestions Sophie. 10:30 works for me. I\'ll update the calendar invite.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-048', size: 150, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Great suggestions Sophie. 10:30 works for me. I\'ll update the calendar invite.\n\nLars - let\'s also add a stretch goal for the email template system if we finish early.\n\n- Dev User' },
    },
  },
  {
    id: 'email-028', threadId: 'thread-015', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 2100, receivedAt: daysAgo(1),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Élise Moreau', email: 'elise.moreau@fjord-systems.example' }], cc: [],
    subject: 'Re: Code review request: JMAP-342 contact import',
    preview: 'Nice work on the vCard parser! Left a few comments on the PR. Main concern is memory usage for large imports.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-049', size: 280, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Nice work on the vCard parser! Left a few comments on the PR.\n\nMain concern: memory usage for large imports (1000+ contacts). Consider using a streaming parser instead of loading the entire file.\n\nAlso, the duplicate detection logic looks solid. Approved with minor changes.\n\n- Dev User' },
    },
  },
  {
    id: 'email-029', threadId: 'thread-018', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 1600, receivedAt: daysAgo(2),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Astrid van der Berg', email: 'astrid@berglabs.example' }], cc: [],
    subject: 'Re: Meeting notes - API design review',
    preview: 'Thanks for the thorough notes Astrid. I\'ll have the OpenAPI spec draft ready by Friday.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-050', size: 120, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Bedankt for the thorough notes Astrid. I\'ll have the OpenAPI spec draft ready by Friday.\n\n- Dev User' },
    },
  },
  {
    id: 'email-030', threadId: 'thread-025', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true }, size: 4800, receivedAt: daysAgo(4),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'Team', email: 'team@fjord-systems.example' }], cc: [],
    subject: 'Proposal: Migrate from REST to JMAP for mail backend',
    preview: 'I\'ve been researching JMAP as a replacement for our current REST-based mail backend. Here\'s the proposal.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-051', size: 900, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hej team,\n\nI\'ve been researching JMAP (RFC 8620/8621) as a replacement for our current REST-based mail backend. Here\'s a summary:\n\nWhy JMAP?\n- Eliminates N+1 query problems with batch requests\n- Built-in push notifications via EventSource\n- Efficient delta sync reduces bandwidth by 60-80%\n- Standardized protocol with growing ecosystem\n\nProposed timeline:\n- Phase 1 (Mar): Proof of concept with mock server\n- Phase 2 (Apr): Core email operations\n- Phase 3 (May): Calendar & contacts integration\n- Phase 4 (Jun): Migration from legacy API\n\nFull proposal document attached.\n\n- Dev User' },
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
    subject: 'Meeting notes (draft)',
    preview: 'Notes from today\'s standup meeting...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-014', size: 200, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Notes from today\'s standup meeting:\n\n- TODO: fill in details\n- Action items: ...' },
    },
  },
  {
    id: 'email-031', threadId: 'thread-026', mailboxIds: { 'mb-drafts': true }, keywords: { $draft: true }, size: 2400, receivedAt: hoursAgo(6),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [], cc: [],
    subject: 'Blog post: Building a JMAP client from scratch (draft)',
    preview: 'Introduction: JMAP is a modern, efficient protocol for email, calendar, and contacts...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-052', size: 500, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Building a JMAP Client from Scratch\n\nIntroduction:\nJMAP is a modern, efficient protocol for email, calendar, and contacts. Unlike IMAP, it uses JSON over HTTP, making it much easier to work with in web applications.\n\nIn this post, we\'ll build a minimal JMAP client in TypeScript that can:\n- Authenticate and discover capabilities\n- List mailboxes and messages\n- Send emails\n\n[TODO: Add code examples]\n[TODO: Add section on error handling]\n[TODO: Conclusion]' },
    },
  },
  {
    id: 'email-032', threadId: 'thread-027', mailboxIds: { 'mb-drafts': true }, keywords: { $draft: true }, size: 1800, receivedAt: daysAgo(1),
    from: [{ name: 'Dev User', email: 'dev@localhost' }],
    to: [{ name: 'CFP Committee', email: 'cfp@fosdem.example' }], cc: [],
    subject: 'Talk proposal: Modern email clients with JMAP',
    preview: 'Title: Modern Email Clients with JMAP - From Protocol to Production...',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-053', size: 400, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Title: Modern Email Clients with JMAP - From Protocol to Production\n\nAbstract:\nThis talk explores building a full-featured webmail client using the JMAP protocol. We\'ll cover session negotiation, efficient data sync, real-time push notifications, and lessons learned.\n\nConference: FOSDEM 2027\nFormat: 30-minute talk\nLevel: Intermediate\n\n[TODO: Add speaker bio]\n[TODO: Complete outline]' },
    },
  },
  // =====================================================================
  // JUNK
  // =====================================================================
  {
    id: 'email-010', threadId: 'thread-009', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 4500, receivedAt: daysAgo(1),
    from: [{ name: 'Totally Real Prince', email: 'prince@scam.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'You have won €1.000.000!!!',
    preview: 'Congratulations! You have been selected as the winner of our international lottery.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-015', size: 500, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Congratulations!\n\nYou have been selected as the winner of our international lottery. To claim your prize, please send your IBAN details to...\n\nCeci n\'est pas un spam.' },
    },
  },
  {
    id: 'email-033', threadId: 'thread-028', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 2200, receivedAt: hoursAgo(8),
    from: [{ name: 'HTCPCP Service', email: 'noreply@teapot.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '418 I\'m a Teapot - Your coffee request was denied',
    preview: 'Per RFC 2324, this server is a teapot and cannot brew coffee. Please try a coffee pot instead.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-054', size: 250, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'HTTP/1.1 418 I\'m a Teapot\n\nPer RFC 2324 (Hyper Text Coffee Pot Control Protocol), this server is, in fact, a teapot. It is short and stout. It cannot brew coffee.\n\nPlease redirect your BREW request to a proper coffee pot.\n\nContent-Type: message/coffeepot\n\nThe teapot abides.' },
    },
  },
  {
    id: 'email-034', threadId: 'thread-029', mailboxIds: { 'mb-junk': true }, keywords: {}, size: 1900, receivedAt: daysAgo(2),
    from: [{ name: 'CryptoTrader Pro', email: 'earn@crypto-gains.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Turn €100 into €10.000 in just 7 days! 🚀',
    preview: 'Our AI trading bot has a 99.9% success rate. Start earning today!',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-055', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'LIMITED TIME OFFER!\n\nOur revolutionary AI trading bot:\n- 99.9% success rate\n- Guaranteed returns\n- No experience needed\n\nSign up now at crypto-gains.example!' },
    },
  },
  // =====================================================================
  // ARCHIVE
  // =====================================================================
  {
    id: 'email-011', threadId: 'thread-010', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true }, size: 3800, receivedAt: daysAgo(14),
    from: [{ name: 'HR Department', email: 'hr@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Updated Holiday Policy - EU Directive Compliance',
    preview: 'Please review the updated paid leave policy effective next month, now with 30 days minimum.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-016', size: 600, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Hej team,\n\nPlease review the updated paid leave policy effective next month. Key changes include:\n\n- Minimum annual leave: 30 days (EU directive compliance)\n- New flexible Friday policy - Freitags um 14:00 Schluss\n- Simplified approval workflow\n- Fika breaks are now officially protected time\n\nFull details in the employee handbook.\n\nBästa hälsningar,\nHR Department' },
    },
  },
  {
    id: 'email-012', threadId: 'thread-011', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true, $flagged: true }, size: 2600, receivedAt: daysAgo(30),
    from: [{ name: 'Sophie Müller', email: 'sophie@eurotech.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Conference talk accepted!',
    preview: 'Toll! Your talk proposal for the JMAP Conf has been accepted!',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-017', size: 350, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Toll!\n\nYour talk proposal "Building Modern Webmail with JMAP" for the JMAP Conf in Amsterdam has been accepted!\n\nThe conference is scheduled for next month at the RAI. More details to follow.\n\nHerzlichen Glückwunsch!\nSophie' },
    },
  },
  {
    id: 'email-035', threadId: 'thread-030', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true }, size: 4200, receivedAt: daysAgo(60),
    from: [{ name: 'IT Abteilung', email: 'it@fjord-systems.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Välkommen! Your development environment setup guide',
    preview: 'Welcome to the team! Here\'s everything you need to set up your development environment.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-056', size: 800, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Välkommen till laget!\n\nHere\'s your development environment setup guide:\n\n1. Clone the monorepo: git clone git@gitlab.example:fjord/monorepo.git\n2. Install dependencies: npm install\n3. Set up local database: docker-compose up -d\n4. Configure environment variables (see .env.example)\n5. Run the test suite: npm test\n\nAccess credentials:\n- Jira: your-email (SSO)\n- GitLab: your-email (SSO)\n- Hetzner Console: IAM user created, check Bitwarden\n\nQuestions? Reach out on #dev-onboarding in Mattermost.\n\nBästa hälsningar,\nIT Abteilung' },
    },
    attachments: [
      { partId: 'att6', blobId: 'blob-att-006', size: 125000, name: 'Entwicklung-Setup-Guide.pdf', type: 'application/pdf' },
    ],
  },
  {
    id: 'email-036', threadId: 'thread-031', mailboxIds: { 'mb-archive': true }, keywords: { $seen: true, $flagged: true }, size: 3100, receivedAt: daysAgo(45),
    from: [{ name: 'ELSTER Online', email: 'noreply@elster.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: 'Ihre Steuererklärung 2025 - Dokumente bereit',
    preview: 'Ihre Lohnsteuerbescheinigung und Steuerbescheid sind zum Download bereit.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-057', size: 300, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Sehr geehrte/r Steuerpflichtige/r,\n\nIhre Steuerdokumente für 2025 sind jetzt verfügbar:\n\n- Lohnsteuerbescheinigung\n- Steuerbescheid\n- Bescheinigung über Kirchensteuer\n\nAbgabefrist: 31. Juli 2026\n\nMelden Sie sich bei elster.example an, um Ihre Erklärung einzureichen.\n\nMit freundlichen Grüßen,\nFinanzamt' },
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
    subject: 'Team building photos from last Friday',
    preview: 'Che bella serata! Sharing the photos from our team building event at the Biergarten.',
    hasAttachment: true,
    textBody: [{ partId: 'p1', blobId: 'blob-058', size: 150, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Che bella serata! 🎉\n\nSharing the photos from our team building event at the Biergarten am Prinsengracht. The Bretzel eating contest was legendary!\n\nPhotos attached. Feel free to share.\n\nChiara' },
    },
    attachments: [
      { partId: 'att8', blobId: 'blob-att-008', size: 2400000, name: 'teambuilding-fotos.zip', type: 'application/zip' },
    ],
  },
  // =====================================================================
  // TRASH
  // =====================================================================
  {
    id: 'email-038', threadId: 'thread-033', mailboxIds: { 'mb-trash': true }, keywords: { $seen: true }, size: 3500, receivedAt: daysAgo(1),
    from: [{ name: 'SaaS Product', email: 'marketing@saas-product.example' }],
    to: [{ name: 'Dev User', email: 'dev@localhost' }], cc: [],
    subject: '🎉 50% off annual plans - limited time!',
    preview: 'Upgrade to our annual plan and save 50%. Offer expires this Sunday.',
    hasAttachment: false,
    textBody: [{ partId: 'p1', blobId: 'blob-059', size: 400, type: 'text/plain' }],
    htmlBody: [],
    bodyValues: {
      p1: { value: 'Spring sale is here!\n\nUpgrade to our annual plan and save 50%.\n\nWhat you get:\n- Unlimited users\n- Priority support\n- Advanced analytics\n- Custom integrations\n\nOffer expires Sunday, March 15, 2026.\n\nUpgrade now at saas-product.example/pricing' },
    },
  },
];

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const IDENTITIES = [
  {
    id: 'identity-001',
    name: 'Dev User',
    email: 'dev@localhost',
    replyTo: null,
    bcc: null,
    textSignature: '-- \nDev User\nBulwark Webmail Developer',
    htmlSignature: '<p>--<br>Dev User<br><em>Bulwark Webmail Developer</em></p>',
    mayDelete: false,
  },
];

// ---------------------------------------------------------------------------
// Address Books & Contacts
// ---------------------------------------------------------------------------

const addressBooks = [
  { id: 'ab-1', name: 'Persönlich', isDefault: true },
  { id: 'ab-2', name: 'Arbeit / Work', isDefault: false },
];

const contacts = [
  // --- Personal address book ---
  { id: 'contact-001', uid: 'urn:uuid:c0000001-0000-0000-0000-000000000001', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Sophie' }, { kind: 'surname', value: 'Müller' }] },
    emails: { e1: { address: 'sophie@eurotech.example' } },
    phones: { p1: { number: '+49 30 8844 2200' } },
    organizations: { o1: { name: 'EuroTech GmbH' } },
    addresses: { a1: { street: [{ value: 'Kurfürstendamm 42' }], locality: 'Berlin', region: '', country: 'Germany', postcode: '10719' } },
    notes: { n1: { note: 'Frontend lead. Always brings Kuchen to the office.' } },
  },
  { id: 'contact-002', uid: 'urn:uuid:c0000002-0000-0000-0000-000000000002', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Pierre' }, { kind: 'surname', value: 'Dubois' }] },
    emails: { e1: { address: 'pierre@dubois.example' } },
    phones: { p1: { number: '+33 1 42 68 53 00' } },
    organizations: { o1: { name: 'Dubois Consulting' } },
    addresses: { a1: { street: [{ value: '42 Rue de Rivoli' }], locality: 'Paris', country: 'France', postcode: '75001' } },
    notes: { n1: { note: 'Product manager. Knows every boulangerie in Paris.' } },
  },
  { id: 'contact-003', uid: 'urn:uuid:c0000003-0000-0000-0000-000000000003', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Chiara' }, { kind: 'surname', value: 'Rossi' }] },
    emails: { e1: { address: 'chiara@rossi.example' } },
    phones: { p1: { number: '+39 02 7634 5678' } },
    organizations: { o1: { name: 'Rossi Design Studio' } },
    addresses: { a1: { street: [{ value: 'Via Montenapoleone 8' }], locality: 'Milano', country: 'Italy', postcode: '20121' } },
    notes: { n1: { note: 'UX designer. Her risotto recipes are legendary.' } },
  },
  { id: 'contact-004', uid: 'urn:uuid:c0000004-0000-0000-0000-000000000004', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Karel' }, { kind: 'surname', value: 'de Vries' }] },
    emails: { e1: { address: 'karel@devries.example' } },
    phones: { p1: { number: '+31 20 555 0142' } },
    addresses: { a1: { street: [{ value: 'Herengracht 142' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1015 BN' } },
    notes: { n1: { note: 'Backend developer. Cycles to work rain or shine - true Dutchman.' } },
  },
  { id: 'contact-005', uid: 'urn:uuid:c0000005-0000-0000-0000-000000000005', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Lars' }, { kind: 'surname', value: 'Johansson' }] },
    emails: { e1: { address: 'lars.johansson@fjord-systems.example' } },
    phones: { p1: { number: '+46 8 123 456 78' } },
    organizations: { o1: { name: 'Fjord Systems AB' } },
    addresses: { a1: { street: [{ value: 'Drottninggatan 42' }], locality: 'Stockholm', country: 'Sweden', postcode: '111 51' } },
    notes: { n1: { note: 'Tech lead. FIKA is sacred. Do not schedule meetings during fika.' } },
  },
  { id: 'contact-006', uid: 'urn:uuid:c0000006-0000-0000-0000-000000000006', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Élise' }, { kind: 'surname', value: 'Moreau' }] },
    emails: { e1: { address: 'elise.moreau@fjord-systems.example' } },
    phones: { p1: { number: '+33 6 12 34 56 78' } },
    organizations: { o1: { name: 'Fjord Systems AB' } },
    addresses: { a1: { street: [{ value: '15 Boulevard Saint-Germain' }], locality: 'Paris', country: 'France', postcode: '75005' } },
    notes: { n1: { note: 'Backend dev. Remote from Paris. Once fixed a production bug from a café terrace.' } },
  },
  { id: 'contact-007', uid: 'urn:uuid:c0000007-0000-0000-0000-000000000007', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Francesco' }, { kind: 'surname', value: 'Bianchi' }] },
    emails: { e1: { address: 'francesco@bianchi.example' } },
    phones: { p1: { number: '+39 06 9876 5432' } },
    addresses: { a1: { street: [{ value: 'Via dei Condotti 22' }], locality: 'Roma', country: 'Italy', postcode: '00187' } },
    notes: { n1: { note: 'Old university friend. Once tried to implement RFC 2549 (IP over Avian Carriers) with actual pigeons. It did not scale.' } },
  },
  { id: 'contact-008', uid: 'urn:uuid:c0000008-0000-0000-0000-000000000008', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Astrid' }, { kind: 'surname', value: 'van der Berg' }] },
    emails: { e1: { address: 'astrid@berglabs.example' } },
    phones: { p1: { number: '+31 70 362 4242' } },
    organizations: { o1: { name: 'BergLabs' } },
    addresses: { a1: { street: [{ value: 'Prinsengracht 263' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1016 GV' } },
    notes: { n1: { note: 'Solutions architect. Her whiteboard diagrams belong in a museum.' } },
  },
  { id: 'contact-009', uid: 'urn:uuid:c0000009-0000-0000-0000-000000000009', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Henrik' }, { kind: 'surname', value: 'Nielsen' }] },
    emails: { e1: { address: 'henrik@nielsen-konsult.example' } },
    phones: { p1: { number: '+45 33 42 42 42' } },
    organizations: { o1: { name: 'Nielsen Konsult' } },
    addresses: { a1: { street: [{ value: 'Nyhavn 42' }], locality: 'København', country: 'Denmark', postcode: '1051' } },
    notes: { n1: { note: 'Freelance DevOps. Speaks 5 languages. Kubernetes kubectl alias: k → kansen.' } },
  },
  { id: 'contact-010', uid: 'urn:uuid:c0000010-0000-0000-0000-000000000010', addressBookIds: { 'ab-1': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Isabelle' }, { kind: 'surname', value: 'Martin' }] },
    emails: { e1: { address: 'isabelle.martin@sorbonne.example' } },
    phones: { p1: { number: '+33 1 44 27 42 42' } },
    organizations: { o1: { name: 'Sorbonne Université' } },
    addresses: { a1: { street: [{ value: '21 Rue de l\'École de Médecine' }], locality: 'Paris', country: 'France', postcode: '75006' } },
    notes: { n1: { note: 'Professor of computer science. Thesis on formal verification of email protocols.' } },
  },
  // --- Work address book ---
  { id: 'contact-011', uid: 'urn:uuid:c0000011-0000-0000-0000-000000000011', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Jacques' }, { kind: 'surname', value: 'Lefèvre' }] },
    emails: { e1: { address: 'jacques@lefevre-avocats.example' } },
    phones: { p1: { number: '+33 1 53 67 42 00' } },
    organizations: { o1: { name: 'Lefèvre & Associés' } },
    addresses: { a1: { street: [{ value: '8 Avenue de l\'Opéra' }], locality: 'Paris', country: 'France', postcode: '75001' } },
    notes: { n1: { note: 'Lawyer. Specializes in IP and tech law. Always replies within 42 minutes.' } },
  },
  { id: 'contact-012', uid: 'urn:uuid:c0000012-0000-0000-0000-000000000012', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Katrin' }, { kind: 'surname', value: 'Bauer' }] },
    emails: { e1: { address: 'katrin.bauer@charite.example' } },
    phones: { p1: { number: '+49 30 450 570 000' } },
    organizations: { o1: { name: 'Charité Klinik Berlin' } },
    addresses: { a1: { street: [{ value: 'Charitéplatz 1' }], locality: 'Berlin', country: 'Germany', postcode: '10117' } },
    notes: { n1: { note: 'Medical center admin. Organizes the best team events in Berlin.' } },
  },
  { id: 'contact-013', uid: 'urn:uuid:c0000013-0000-0000-0000-000000000013', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Liam' }, { kind: 'surname', value: 'Ó Donaill' }] },
    emails: { e1: { address: 'liam.odonaill@finanz.example' } },
    phones: { p1: { number: '+353 1 677 4242' } },
    organizations: { o1: { name: 'Finanz Dublin' } },
    addresses: { a1: { street: [{ value: '42 St. Stephen\'s Green' }], locality: 'Dublin', country: 'Ireland', postcode: 'D02 HX65' } },
    notes: { n1: { note: 'Finance lead. Can explain SEPA regulations over a pint of Guinness.' } },
  },
  { id: 'contact-014', uid: 'urn:uuid:c0000014-0000-0000-0000-000000000014', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'María' }, { kind: 'surname', value: 'García' }] },
    emails: { e1: { address: 'maria@garcia-design.example' } },
    phones: { p1: { number: '+34 91 420 4242' } },
    organizations: { o1: { name: 'García Design Studio' } },
    addresses: { a1: { street: [{ value: 'Calle Gran Vía 42' }], locality: 'Madrid', country: 'Spain', postcode: '28013' } },
    notes: { n1: { note: 'Brand designer. Her color palettes are pure art. Siesta enthusiast.' } },
  },
  { id: 'contact-015', uid: 'urn:uuid:c0000015-0000-0000-0000-000000000015', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Nils' }, { kind: 'surname', value: 'Andersson' }] },
    emails: { e1: { address: 'nils@digitaal.example' } },
    phones: { p1: { number: '+31 20 624 1337' } },
    organizations: { o1: { name: 'Digitaal BV' } },
    addresses: { a1: { street: [{ value: 'Vijzelstraat 42' }], locality: 'Amsterdam', country: 'Netherlands', postcode: '1017 HK' } },
    notes: { n1: { note: 'Platform engineer. fika buddy. Appreciates a good kanelbulle.' } },
  },
  { id: 'contact-016', uid: 'urn:uuid:c0000016-0000-0000-0000-000000000016', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Olivia' }, { kind: 'surname', value: 'Kowalska' }] },
    emails: { e1: { address: 'olivia@kowalska-marketing.example' } },
    phones: { p1: { number: '+48 22 505 4242' } },
    organizations: { o1: { name: 'Kowalska Marketing' } },
    addresses: { a1: { street: [{ value: 'ul. Nowy Świat 42' }], locality: 'Warszawa', country: 'Poland', postcode: '00-363' } },
    notes: { n1: { note: 'Marketing strategist. Her campaign analytics dashboards are works of art.' } },
  },
  { id: 'contact-017', uid: 'urn:uuid:c0000017-0000-0000-0000-000000000017', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Pádraig' }, { kind: 'surname', value: 'Murphy' }] },
    emails: { e1: { address: 'padraig@murphy-bau.example' } },
    phones: { p1: { number: '+353 86 123 4242' } },
    organizations: { o1: { name: 'Murphy Bau GmbH' } },
    addresses: { a1: { street: [{ value: 'Grafton Street 42' }], locality: 'Dublin', country: 'Ireland', postcode: 'D02 R296' } },
    notes: { n1: { note: 'Construction project manager. Irish-German bilingual. Builds things that last.' } },
  },
  { id: 'contact-018', uid: 'urn:uuid:c0000018-0000-0000-0000-000000000018', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Raquel' }, { kind: 'surname', value: 'Ferreira' }] },
    emails: { e1: { address: 'raquel@ferreira-media.example' } },
    phones: { p1: { number: '+351 21 342 4242' } },
    organizations: { o1: { name: 'Ferreira Media' } },
    addresses: { a1: { street: [{ value: 'Rua Augusta 42' }], locality: 'Lisboa', country: 'Portugal', postcode: '1100-053' } },
    notes: { n1: { note: 'Media consultant. Can turn any press release into poetry. Loves pastéis de nata.' } },
  },
  { id: 'contact-019', uid: 'urn:uuid:c0000019-0000-0000-0000-000000000019', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Sébastien' }, { kind: 'surname', value: 'Dumont' }] },
    emails: { e1: { address: 'sebastien@dumont-conseil.example' } },
    phones: { p1: { number: '+32 2 555 4242' } },
    organizations: { o1: { name: 'Dumont Conseil' } },
    addresses: { a1: { street: [{ value: 'Avenue Louise 42' }], locality: 'Bruxelles', country: 'Belgium', postcode: '1050' } },
    notes: { n1: { note: 'Strategy consultant. Knows the difference between Belgian and French chocolate. Will argue passionately about it.' } },
  },
  { id: 'contact-020', uid: 'urn:uuid:c0000020-0000-0000-0000-000000000020', addressBookIds: { 'ab-2': true }, kind: 'individual',
    name: { components: [{ kind: 'given', value: 'Annika' }, { kind: 'surname', value: 'Lindgren' }] },
    emails: { e1: { address: 'annika@lindgren.example' }, e2: { address: 'annika.personal@proton.example' } },
    phones: { p1: { number: '+46 70 123 4242' } },
    organizations: { o1: { name: 'Lindgren Consulting' } },
    addresses: { a1: { street: [{ value: 'Strandvägen 42' }], locality: 'Stockholm', country: 'Sweden', postcode: '114 56' } },
    nicknames: { n1: { name: 'Anni' } },
    notes: { n1: { note: 'Independent consultant specializing in GDPR compliance. Yes, she has opinions about cookie banners.' } },
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
  { id: 'cal-1', name: 'Persönlich', color: '#4285f4', isVisible: true, isDefault: true },
  { id: 'cal-2', name: 'Arbeit', color: '#0b8043', isVisible: true, isDefault: false },
  { id: 'cal-3', name: 'Team', color: '#8e24aa', isVisible: true, isDefault: false },
  { id: 'cal-4', name: 'Feiertage (EU)', color: '#f4511e', isVisible: true, isDefault: false },
  { id: 'cal-5', name: 'Geburtstage', color: '#e67c73', isVisible: true, isDefault: false },
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
    location: 'Konferenzsaal A',
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
  makeEvent('evt-003', 'cal-2', '1:1 with Lars', localDateTime(0, 14, 0), 'PT42M', {
    virtualLocations: { vl1: { uri: 'https://meet.example/lars-dev', name: 'Zoom' } },
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Lars Johansson', 'lars.johansson@fjord-systems.example'),
    },
    description: 'Weekly catch-up. Duration: exactly 42 minutes - the answer to everything.',
  }),
  makeEvent('evt-004', 'cal-2', 'Code Review Session', localDateTime(0, 16, 0), 'PT1H', {
    location: 'Konferenzsaal B',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Élise Moreau', 'elise.moreau@fjord-systems.example'),
    },
    description: 'Review JMAP-342 contact import PR.',
  }),
  makeEvent('evt-005', 'cal-2', 'Architecture Review', localDateTime(2, 11, 0), 'PT1H30M', {
    location: 'Konferenzsaal A',
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
    description: 'Discuss API rate limit escalation for EuroTech enterprise account.',
  }),
  makeEvent('evt-007', 'cal-2', 'Deployment Window', localDateTime(3, 22, 0), 'PT2H', {
    description: 'Production deployment: JMAP calendar integration v2.3.\nRollback plan in Confluence.\nOn-call: Henrik Nielsen.',
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
    location: 'Konferenzsaal B',
    participants: {
      p1: participant('Liam Ó Donaill', 'liam.odonaill@finanz.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Nils Andersson', 'nils@digitaal.example'),
    },
  }),
  makeEvent('evt-009', 'cal-2', 'Retro & Demo', localDateTime(4, 15, 0), 'PT1H30M', {
    location: 'Konferenzsaal A',
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
    description: 'Stripe API v2023-10 deprecated. Must be on v2025-01 by today.',
    color: '#d50000',
  }),

  // ===== Team calendar (cal-3) - social & team =====
  makeEvent('evt-012', 'cal-3', 'Biergarten Abend 🍺', localDateTime(5, 18, 0), 'PT3H', {
    location: 'Biergarten am Prinsengracht, Amsterdam',
    description: 'Monthly team social. Bretzel buffet included.\nVegetarian options: Käsespätzle, Kartoffelsalat.\nBring your own Dirndl/Lederhosen (optional but encouraged).',
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
  makeEvent('evt-014', 'cal-3', 'Lunch & Learn: JMAP Protocol Deep Dive', localDateTime(4, 12, 0), 'PT1H', {
    location: 'Kantine, 2. OG',
    description: 'Presenter: Dev User\nTopic: How JMAP solves the N+1 problem and why it\'s better than IMAP for modern clients.\nPizza will be provided.',
    participants: {
      p1: participant('Dev User', 'dev@localhost', 'owner'),
      p2: participant('Astrid van der Berg', 'astrid@berglabs.example'),
      p3: participant('Isabelle Martin', 'isabelle.martin@sorbonne.example'),
    },
  }),
  makeEvent('evt-015', 'cal-3', 'Eurovision Watch Party 🎤✨', localDateTime(60, 20, 0), 'PT4H', {
    location: 'Sophie\'s apartment, Kreuzberg, Berlin',
    description: 'Annual Eurovision Song Contest watch party!\n\nRules:\n1. Scorecards mandatory (printed copies provided)\n2. Drink when someone says "douze points"\n3. Best costume contest (prize: a waffle iron)\n4. No spoilers from the semis!\n\nBring: snacks from your home country.',
    participants: {
      p1: participant('Sophie Müller', 'sophie@eurotech.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
      p4: participant('Chiara Rossi', 'chiara@rossi.example'),
      p5: participant('Katrin Bauer', 'katrin.bauer@charite.example'),
      p6: participant('Nils Andersson', 'nils@digitaal.example'),
    },
  }),
  makeEvent('evt-016', 'cal-3', 'Cooking Class - Pasta Fresca', localDateTime(12, 18, 30), 'PT2H30M', {
    location: 'La Cucina Cooking School, Jordaan, Amsterdam',
    description: 'Team cooking class: fresh pasta from scratch.\nMenu: tagliatelle al ragù, ravioli ricotta e spinaci.\nChef: Chiara Rossi (guest instructor)',
    participants: {
      p1: participant('Chiara Rossi', 'chiara@rossi.example', 'owner'),
      p2: participant('Dev User', 'dev@localhost'),
      p3: participant('Pierre Dubois', 'pierre@dubois.example'),
      p4: participant('Katrin Bauer', 'katrin.bauer@charite.example'),
    },
  }),

  // ===== Personal calendar (cal-1) =====
  makeEvent('evt-017', 'cal-1', 'Fika with Nils', localDateTime(2, 15, 30), 'PT1H', {
    location: 'Café de Flore, Prinsengracht, Amsterdam',
    description: 'Catch-up over coffee and kanelbullar.',
  }),
  makeEvent('evt-018', 'cal-1', 'Lake Como Weekend', localDateTime(14, 10, 0), 'P2D', {
    location: 'Villa sul Lago, Bellagio, Lake Como',
    description: 'Weekend getaway.\nConfirmation: EU42GDPR\nCheck-in: 15:00\nCheck-out: 11:00',
    showWithoutTime: true,
  }),
  makeEvent('evt-019', 'cal-1', 'Tandarts (Dentist)', localDateTime(7, 9, 30), 'PT45M', {
    location: 'Tandartspraktijk Centrum, Reguliersgracht 12, Amsterdam',
    description: 'Regular check-up. Don\'t forget to floss!',
    alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'start' }, action: 'display' } },
  }),
  makeEvent('evt-020', 'cal-1', 'Albert Cuyp Markt', localDateTime(6, 10, 0), 'PT2H', {
    location: 'Albert Cuypstraat, Amsterdam',
    description: 'Saturday market run.\nShopping list: stroopwafels, Gouda, tulips, fresh bread, olives.',
    showWithoutTime: false,
  }),
  makeEvent('evt-021', 'cal-1', 'Cycling to Vondelpark', localDateTime(6, 14, 0), 'PT1H30M', {
    location: 'Vondelpark, Amsterdam',
    description: 'Afternoon bike ride. Meet at the main entrance.',
  }),
  makeEvent('evt-022', 'cal-1', 'Yoga Class', localDateTime(0, 7, 0), 'PT1H', {
    location: 'De Nieuwe Yogaschool, Laurierstraat, Amsterdam',
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }, { day: 'fr' }] }],
  }),
  makeEvent('evt-023', 'cal-1', 'Dutch Language Lesson', localDateTime(1, 19, 0), 'PT1H30M', {
    location: 'Taleninstituut, Plantage Middenlaan, Amsterdam',
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'tu' }] }],
    description: 'Semester 3 - past tense and separable verbs. Ik heb geprobeerd...',
  }),
  makeEvent('evt-024', 'cal-1', 'Call with Mum', localDateTime(0, 18, 30), 'PT30M', {
    recurrence: [{ frequency: 'weekly', byDay: [{ day: 'su' }] }],
    description: 'Weekly call home.',
  }),
  // Overlapping personal events
  makeEvent('evt-025', 'cal-1', 'Haircut', localDateTime(6, 14, 30), 'PT45M', {
    location: 'Kapper de Luxe, Utrechtsestraat, Amsterdam',
    description: 'Overlaps with Vondelpark bike ride - need to reschedule one!',
  }),

  // ===== Holiday calendar (cal-4) - all-day events =====
  makeEvent('evt-026', 'cal-4', 'Koningsdag 🧡', localDateTime(42, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'King\'s Day - national holiday in the Netherlands.\nWear orange! Visit a vrijmarkt. Eat tompouce.',
    color: '#ff6d00',
  }),
  makeEvent('evt-027', 'cal-4', 'Tag der Arbeit', localDateTime(48, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Labour Day - public holiday in most EU countries.',
  }),
  makeEvent('evt-028', 'cal-4', 'Europe Day 🇪🇺', localDateTime(55, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Anniversary of the Schuman Declaration (1950). The foundation of European integration.',
    color: '#003399',
  }),
  makeEvent('evt-029', 'cal-4', 'Bevrijdingsdag', localDateTime(52, 0, 0), 'P1D', {
    showWithoutTime: true,
    description: 'Liberation Day - Dutch national holiday commemorating the end of WWII occupation.',
  }),

  // ===== Birthday calendar (cal-5) =====
  makeEvent('evt-030', 'cal-5', '🎂 Sophie Müller', localDateTime(8, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Don\'t forget to bring Kuchen!',
  }),
  makeEvent('evt-031', 'cal-5', '🎂 Chiara Rossi', localDateTime(21, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'She prefers tiramisu over cake.',
  }),
  makeEvent('evt-032', 'cal-5', '🎂 Pierre Dubois', localDateTime(45, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Likes a good Bordeaux.',
  }),
  makeEvent('evt-033', 'cal-5', '🎂 Lars Johansson', localDateTime(-3, 0, 0), 'P1D', {
    showWithoutTime: true,
    recurrence: [{ frequency: 'yearly' }],
    description: 'Just passed! Hope you remembered.',
  }),

  // ===== JMAP Conf & travel (work calendar) =====
  makeEvent('evt-034', 'cal-2', 'JMAP Conf Amsterdam', localDateTime(28, 9, 0), 'P2D', {
    location: 'RAI Amsterdam Convention Centre',
    showWithoutTime: true,
    description: 'Your talk: "Building Modern Webmail with JMAP" - Day 1, 14:00, Main Hall.\nDon\'t forget slide deck!',
    participants: {
      p1: participant('Dev User', 'dev@localhost'),
      p2: participant('Sophie Müller', 'sophie@eurotech.example'),
      p3: participant('Isabelle Martin', 'isabelle.martin@sorbonne.example'),
    },
  }),
  makeEvent('evt-035', 'cal-2', 'FOSDEM Talk Prep', localDateTime(10, 13, 0), 'PT2H', {
    virtualLocations: { vl1: { uri: 'https://meet.example/fosdem-prep', name: 'Meet' } },
    description: 'Rehearse FOSDEM 2027 talk proposal.\nTitle: "Modern Email Clients with JMAP - From Protocol to Production"',
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
          const keyword = key.slice('keywords/'.length);
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
  const create = args.create as Record<string, unknown> | undefined;
  if (create) {
    for (const key of Object.keys(create)) {
      created[key] = { id: `identity-new-${Date.now()}-${key}` };
    }
  }
  return ['Identity/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created, updated: null, destroyed: null }, callId];
}

function handleThreadGet(args: MethodArgs, callId: string): MethodResult {
  const ids = args.ids as string[] | undefined;
  const threads = buildThreads();
  const list = ids ? threads.filter((t) => ids.includes(t.id)) : threads;
  return ['Thread/get', { accountId: ACCOUNT_ID, state: nextState(), list, notFound: [] }, callId];
}

function handleEmailSubmissionSet(_args: MethodArgs, callId: string): MethodResult {
  return ['EmailSubmission/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created: { 'sub-1': { id: 'sub-mock-1' } }, notCreated: null }, callId];
}

function handleQuotaGet(_args: MethodArgs, callId: string): MethodResult {
  return ['Quota/get', { accountId: ACCOUNT_ID, state: nextState(), list: [{ resourceType: 'mail', scope: 'mail', used: 52428800, hardLimit: 1073741824 }], notFound: [] }, callId];
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

// Catch-all for unknown methods
function handleUnknown(method: string, _args: MethodArgs, callId: string): MethodResult {
  return ['error', { type: 'unknownMethod', description: `Mock server does not implement ${method}` }, callId];
}

const METHOD_HANDLERS: Record<string, (args: MethodArgs, callId: string) => MethodResult> = {
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
  'Calendar/get': handleCalendarGet,
  'CalendarEvent/get': handleCalendarEventGet,
  'CalendarEvent/query': handleCalendarEventQuery,
  'CalendarEvent/set': (_args, callId) => ['CalendarEvent/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created: null, updated: null, destroyed: null }, callId],
  'SieveScript/get': handleSieveScriptGet,
  'SieveScript/set': (_args, callId) => ['SieveScript/set', { accountId: ACCOUNT_ID, oldState: nextState(), newState: nextState(), created: null, updated: null, destroyed: null }, callId],
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
          maxCallsInRequest: 16,
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
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
            'urn:ietf:params:jmap:submission': {},
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

      const responses: MethodResult[] = [];

      // Process method calls sequentially (to support back-references)
      const resolved = resolveBackReferences(methodCalls, responses);
      for (let i = 0; i < methodCalls.length; i++) {
        const [method, , callId] = methodCalls[i];
        // Use resolved args if available, otherwise original
        const args = i < resolved.length ? resolved[i][1] : methodCalls[i][1];

        const handler = METHOD_HANDLERS[method];
        if (handler) {
          const result = handler(args, callId);
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
