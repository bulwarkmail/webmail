import type { Email } from '@/lib/jmap/types';
import { demoDate } from '../demo-utils';

const USER = { name: 'Demo User', email: 'demo@example.com' } as const;

// Helper to keep the fixtures short - auto-assigns a partId/blobId per body.
let bodyCounter = 0;
function body(value: string, type: 'text/plain' | 'text/html' = 'text/plain') {
  const partId = String(++bodyCounter);
  const blobId = `blob-${partId}`;
  return {
    part: { partId, blobId, size: value.length, type },
    values: { [partId]: { value } },
  };
}

/** Build text+html parts in one shot. */
function bodies(text: string, html: string) {
  const t = body(text, 'text/plain');
  const h = body(html, 'text/html');
  return {
    textBody: [t.part],
    htmlBody: [h.part],
    bodyValues: { ...t.values, ...h.values },
  };
}

function textOnly(text: string) {
  const t = body(text, 'text/plain');
  return { textBody: [t.part], bodyValues: t.values };
}

export function createDemoEmails(): Email[] {
  return [
    // ── Inbox ───────────────────────────────────────────────────
    {
      id: 'demo-email-1',
      threadId: 'demo-thread-1',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 4200,
      receivedAt: demoDate(0, -2),
      from: [{ name: 'Bulwark Team', email: 'welcome@bulwark.email' }],
      to: [USER],
      subject: 'Welcome to Bulwark Mail!',
      sentAt: demoDate(0, -2),
      preview: 'Thanks for trying out Bulwark Mail. This is a demo environment where you can explore all features...',
      hasAttachment: false,
      ...bodies(
        'Thanks for trying out Bulwark Mail!\n\nThis is a demo environment where you can explore all features without connecting to a real server. All data stays on your device.\n\nFeel free to:\n- Read, compose, and organize emails\n- Manage contacts and calendars\n- Configure filters and settings\n- Try keyboard shortcuts (press ? to see them)\n\nEnjoy exploring!',
        '<div><h2>Welcome to Bulwark Mail!</h2><p>Thanks for trying out Bulwark Mail!</p><p>This is a demo environment where you can explore all features without connecting to a real server. <strong>All data stays on your device.</strong></p><p>Feel free to:</p><ul><li>Read, compose, and organize emails</li><li>Manage contacts and calendars</li><li>Configure filters and settings</li><li>Try keyboard shortcuts (press <kbd>?</kbd> to see them)</li></ul><p>Enjoy exploring!</p></div>',
      ),
      messageId: '<welcome@demo.bulwark.email>',
    },

    // Mom - personal message, unread
    {
      id: 'demo-email-mom',
      threadId: 'demo-thread-mom',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 1900,
      receivedAt: demoDate(0, -4, -12),
      from: [{ name: 'Sofia Russo', email: 'sofia.russo@example.com' }],
      to: [USER],
      subject: 'when are you coming home?',
      sentAt: demoDate(0, -4, -12),
      preview: 'Hi sweetie, your father and I were just talking - we miss you. Any chance you can come down for a weekend...',
      hasAttachment: false,
      ...textOnly(
        "Hi sweetie,\n\nYour father and I were just talking - we miss you. Any chance you can come down for a weekend before Christmas?\n\nNo pressure if you're swamped with work. Anna said she might be in town the 22nd, would be nice to all be in one place again.\n\nThe lemon tree finally fruited! Twelve lemons. I'll save you some.\n\nLove,\nMom",
      ),
      messageId: '<5a8c-mom@example.com>',
    },

    // GitHub - PR review request
    {
      id: 'demo-email-gh-pr',
      threadId: 'demo-thread-gh-pr',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 6400,
      receivedAt: demoDate(0, -3, -5),
      from: [{ name: 'Alice Johnson (via GitHub)', email: 'notifications@github.com' }],
      replyTo: [{ name: 'reply', email: 'reply+abc123@reply.github.com' }],
      to: [USER],
      subject: '[acme/api-gateway] Add token-bucket rate limiter (#1284)',
      sentAt: demoDate(0, -3, -5),
      preview: '@demo-user requested your review on this pull request. Replaces the fixed-window limiter with a leaky token-bucket...',
      hasAttachment: false,
      ...bodies(
        '@demo-user requested your review on this pull request.\n\nReplaces the fixed-window limiter with a leaky token-bucket so we stop punishing clients at the second-boundary edge. Per-endpoint config lives in rate-limit.toml.\n\nThree files changed, +312 −47.\n\nView it on GitHub:\nhttps://github.com/acme/api-gateway/pull/1284\n\n-\nReply to this email directly, or view it on GitHub.',
        '<table style="font-family:-apple-system,sans-serif"><tr><td><strong>@demo-user</strong> requested your review on this pull request.</td></tr><tr><td style="padding-top:12px">Replaces the fixed-window limiter with a leaky token-bucket so we stop punishing clients at the second-boundary edge. Per-endpoint config lives in <code>rate-limit.toml</code>.</td></tr><tr><td style="padding-top:12px;color:#666">Three files changed, <span style="color:#16a34a">+312</span> <span style="color:#dc2626">−47</span></td></tr><tr><td style="padding-top:16px"><a href="https://github.com/acme/api-gateway/pull/1284" style="background:#1f2328;color:#fff;padding:8px 16px;text-decoration:none;border-radius:6px">View on GitHub</a></td></tr></table>',
      ),
      messageId: '<acme/api-gateway/pull/1284@github.com>',
    },

    // Hacker Newsletter - newsletter, read
    {
      id: 'demo-email-2',
      threadId: 'demo-thread-2',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 18500,
      receivedAt: demoDate(-1, -5),
      from: [{ name: 'TechDigest Weekly', email: 'newsletter@techdigest.example' }],
      to: [USER],
      subject: 'Issue #218 - RFC 9844, the second WebAssembly draft, and a quiet announcement from Mozilla',
      sentAt: demoDate(-1, -5),
      preview: 'Your weekly roundup of the most important technology news and open source developments...',
      hasAttachment: false,
      ...bodies(
        'TechDigest #218\n\n- THE WEEK IN STANDARDS -\n\n1. RFC 9844: Per-message TLS extensions are now official. The implications for SMTP delivery reports are surprisingly large - Mike Crispin has a write-up that runs through what changes for transactional senders.\n\n2. WebAssembly 2.0 (second public draft). Tail calls are in. SIMD is in. Component model is *almost* in but punted to a separate spec, which feels like the right call.\n\n3. Mozilla quietly shipped a privacy-preserving telemetry channel to Firefox 132. No, it doesn\'t replace ad tracking. Yes, it\'s a real cryptographic system. Worth reading the post.\n\n- TOOLS -\n\n- Datasette 1.0 is out. Ten years from the first commit.\n- Fly.io published their object store, Tigris-style, written in Go.\n- Linear added an SSO migration tool that actually handles the IdP-initiated case.\n\n- ESSAYS -\n\n* "Postgres is enough" by E. Tan - a long-form rebuttal to the microservices-by-default pattern.\n* "I rewrote my home network in TypeScript so you don\'t have to" - exactly what it sounds like.\n\n- UNSUBSCRIBE -\n\nManage your subscription at techdigest.example/manage.',
        '<div style="max-width:560px;margin:0 auto;font-family:-apple-system,sans-serif;line-height:1.5"><div style="border-bottom:2px solid #111;padding-bottom:16px"><div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#888">TechDigest · Issue #218</div><h1 style="font-size:22px;margin:4px 0 0">RFC 9844, the second WebAssembly draft, and a quiet announcement from Mozilla</h1></div><h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-top:24px">The week in standards</h2><p><strong>1.</strong> RFC 9844: Per-message TLS extensions are now official. The implications for SMTP delivery reports are surprisingly large - Mike Crispin has a <a href="#" style="color:#db2d54">write-up</a> that runs through what changes for transactional senders.</p><p><strong>2.</strong> WebAssembly 2.0 (second public draft). Tail calls are in. SIMD is in. Component model is <em>almost</em> in but punted to a separate spec, which feels like the right call.</p><p><strong>3.</strong> Mozilla quietly shipped a privacy-preserving telemetry channel to Firefox 132. No, it doesn\'t replace ad tracking. Yes, it\'s a real cryptographic system.</p><h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-top:24px">Tools</h2><ul><li>Datasette 1.0 is out. Ten years from the first commit.</li><li>Fly.io published their object store, Tigris-style, written in Go.</li><li>Linear added an SSO migration tool that actually handles the IdP-initiated case.</li></ul><h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-top:24px">Essays</h2><p style="margin:0 0 6px">"Postgres is enough" by E. Tan - a long-form rebuttal to the microservices-by-default pattern.</p><p style="margin:0">"I rewrote my home network in TypeScript so you don\'t have to" - exactly what it sounds like.</p><div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888">Manage your subscription at <a href="#" style="color:#888">techdigest.example/manage</a></div></div>',
      ),
      messageId: '<weekly-218@techdigest.example>',
    },

    // Thread: Q4 Project Timeline - Alice → Bob → Alice (4 messages)
    {
      id: 'demo-email-3a',
      threadId: 'demo-thread-3',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 3100,
      receivedAt: demoDate(-3, -10),
      from: [{ name: 'Alice Johnson', email: 'alice.johnson@example.com' }],
      to: [USER, { name: 'Bob Chen', email: 'bob.chen@example.com' }],
      subject: 'Q4 Project Timeline',
      sentAt: demoDate(-3, -10),
      preview: 'Hi team, I wanted to share the updated timeline for our Q4 deliverables...',
      hasAttachment: false,
      ...bodies(
        'Hi team,\n\nI wanted to share the updated timeline for our Q4 deliverables:\n\n- Phase 1: Design review - Oct 15\n- Phase 2: Development - Nov 1-30\n- Phase 3: Testing - Dec 1-15\n- Phase 4: Launch - Dec 20\n\nPlease review and let me know if you see any conflicts.\n\nBest,\nAlice',
        '<p>Hi team,</p><p>I wanted to share the updated timeline for our Q4 deliverables:</p><ul><li>Phase 1: Design review - Oct 15</li><li>Phase 2: Development - Nov 1-30</li><li>Phase 3: Testing - Dec 1-15</li><li>Phase 4: Launch - Dec 20</li></ul><p>Please review and let me know if you see any conflicts.</p><p>Best,<br>Alice</p>',
      ),
      messageId: '<q4-timeline-1@example.com>',
    },
    {
      id: 'demo-email-3b',
      threadId: 'demo-thread-3',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 3500,
      receivedAt: demoDate(-2, -8),
      from: [{ name: 'Bob Chen', email: 'bob.chen@example.com' }],
      to: [{ name: 'Alice Johnson', email: 'alice.johnson@example.com' }, USER],
      subject: 'Re: Q4 Project Timeline',
      sentAt: demoDate(-2, -8),
      preview: 'Looks good to me! One concern: the testing window might be tight given the holidays...',
      hasAttachment: false,
      ...textOnly(
        "Looks good to me! One concern: the testing window might be tight given the holidays. Could we start testing a few days earlier?\n\nAlso, should we set up a shared doc for tracking blockers?\n\n- Bob",
      ),
      messageId: '<q4-timeline-2@example.com>',
      inReplyTo: ['<q4-timeline-1@example.com>'],
      references: ['<q4-timeline-1@example.com>'],
    },
    {
      id: 'demo-email-3c',
      threadId: 'demo-thread-3',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 3800,
      receivedAt: demoDate(-1, -3),
      from: [{ name: 'Alice Johnson', email: 'alice.johnson@example.com' }],
      to: [{ name: 'Bob Chen', email: 'bob.chen@example.com' }, USER],
      subject: 'Re: Q4 Project Timeline',
      sentAt: demoDate(-1, -3),
      preview: "Great point Bob. Let's move testing to Nov 28. I'll create the shared doc today...",
      hasAttachment: false,
      ...textOnly(
        "Great point Bob. Let's move testing to Nov 28. I'll create the shared doc today and share the link.\n\nUpdated timeline:\n- Design review: Oct 15\n- Development: Nov 1-27\n- Testing: Nov 28 - Dec 15\n- Launch: Dec 20\n\n- Alice",
      ),
      messageId: '<q4-timeline-3@example.com>',
      inReplyTo: ['<q4-timeline-2@example.com>'],
      references: ['<q4-timeline-1@example.com>', '<q4-timeline-2@example.com>'],
    },

    // Stripe receipt
    {
      id: 'demo-email-stripe',
      threadId: 'demo-thread-stripe',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 11200,
      receivedAt: demoDate(-1, -1, -22),
      from: [{ name: 'Stripe', email: 'receipts@stripe.com' }],
      to: [USER],
      subject: 'Your receipt from Linear Inc. [#2451-9928]',
      sentAt: demoDate(-1, -1, -22),
      preview: 'Receipt from Linear Inc. for $16.00. Thanks for your business.',
      hasAttachment: false,
      ...bodies(
        'Receipt from Linear Inc.\nAmount paid: $16.00\nDate paid: yesterday\nPayment method: Visa •••• 4242\n\nDescription: Linear Standard (monthly)\n\nReceipt #2451-9928\n\nThis charge will appear on your statement as LINEAR INC.\n\nQuestions? Contact support@linear.app.',
        '<div style="max-width:560px;margin:0 auto;font-family:-apple-system,sans-serif"><div style="text-align:center;padding:24px 0"><div style="font-size:11px;letter-spacing:0.12em;color:#888;text-transform:uppercase">Receipt</div><div style="font-size:32px;font-weight:700;margin-top:4px">$16.00</div><div style="color:#666;margin-top:4px">Linear Inc.</div></div><table style="width:100%;border-top:1px solid #eee;border-bottom:1px solid #eee"><tr><td style="padding:10px 0;color:#666">Amount</td><td style="padding:10px 0;text-align:right">$16.00</td></tr><tr><td style="padding:10px 0;color:#666;border-top:1px solid #f4f4f4">Payment method</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f4f4f4">Visa •••• 4242</td></tr><tr><td style="padding:10px 0;color:#666;border-top:1px solid #f4f4f4">Receipt number</td><td style="padding:10px 0;text-align:right;border-top:1px solid #f4f4f4;font-family:monospace">2451-9928</td></tr></table><p style="color:#666;font-size:13px;margin-top:24px">Description: Linear Standard (monthly). This charge will appear on your statement as LINEAR INC.</p></div>',
      ),
      messageId: '<receipt-2451-9928@stripe.com>',
    },

    // Email with attachments - invoice
    {
      id: 'demo-email-4',
      threadId: 'demo-thread-4',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 245000,
      receivedAt: demoDate(0, -6),
      from: [{ name: 'Sarah Kim', email: 'sarah.kim@example.com' }],
      to: [USER],
      subject: 'Invoice #2024-089 & landing-page prototype v3',
      sentAt: demoDate(0, -6),
      preview: "Hi, please find attached the invoice for October and a screenshot of the latest prototype...",
      hasAttachment: true,
      ...textOnly(
        "Hi,\n\nPlease find attached the invoice for October and a screenshot of the latest prototype. I went with Option B for the hero (the one with the asymmetric grid) since you mentioned the symmetrical version felt too flat in our last call.\n\nIf the invoice line items look off, ping me - I had to back out the November pre-payment.\n\nBest regards,\nSarah",
      ),
      attachments: [
        { partId: 'att-1', blobId: 'demo-blob-att-1', size: 145000, name: 'Invoice-2024-089.pdf', type: 'application/pdf' },
        { partId: 'att-2', blobId: 'demo-blob-att-2', size: 21864, name: 'prototype-v3.png', type: 'image/png' },
      ],
      messageId: '<invoice-089@example.com>',
    },

    // Carlos - starred, social
    {
      id: 'demo-email-5',
      threadId: 'demo-thread-5',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true, $flagged: true },
      size: 2800,
      receivedAt: demoDate(-2, -1),
      from: [{ name: 'Carlos Rivera', email: 'carlos.rivera@example.com' }],
      to: [USER],
      subject: 'Friday dinner - moved to 7:30 (sorry!)',
      sentAt: demoDate(-2, -1),
      preview: 'Quick heads up - had to push the dinner back half an hour. Bistro could only do the late seating...',
      hasAttachment: false,
      ...textOnly(
        "Quick heads up - had to push the dinner back half an hour. Bistro could only do the late seating.\n\nNew time: Friday, 7:30 PM\nThe Garden Bistro, 123 Oak Street\n\nReservation under my name, 8 people. Let me know if that doesn't work for you and I can try to wrangle something.\n\nCheers,\nCarlos",
      ),
      messageId: '<dinner-reminder@example.com>',
    },

    // Linear - issue assigned
    {
      id: 'demo-email-linear',
      threadId: 'demo-thread-linear',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 5400,
      receivedAt: demoDate(0, -7, -15),
      from: [{ name: 'Linear', email: 'notifications@linear.app' }],
      to: [USER],
      subject: 'BUL-2031 was assigned to you - "Compose: drag-and-drop attachments duplicated on slow networks"',
      sentAt: demoDate(0, -7, -15),
      preview: 'Priya Sharma assigned this issue to you. Repro on a throttled connection (Slow 3G): drop a file twice and...',
      hasAttachment: false,
      ...bodies(
        "Priya Sharma assigned BUL-2031 to you.\n\nTitle: Compose: drag-and-drop attachments duplicated on slow networks\nPriority: Medium\n\nRepro on a throttled connection (Slow 3G): drop a file twice in quick succession into the compose drop zone. The first upload doesn't get debounced and both attempts complete, so the attachment shows up twice in the draft.\n\nOpen in Linear: https://linear.app/bulwark/issue/BUL-2031",
        '<table style="font-family:-apple-system,sans-serif;max-width:520px"><tr><td><div style="font-size:11px;color:#888;letter-spacing:0.08em;text-transform:uppercase">Linear · BUL-2031</div><div style="font-size:18px;font-weight:600;margin-top:6px">Compose: drag-and-drop attachments duplicated on slow networks</div><div style="margin-top:8px;color:#666"><strong>Priya Sharma</strong> assigned this issue to you · Priority Medium</div></td></tr><tr><td style="padding-top:16px;color:#444">Repro on a throttled connection (Slow 3G): drop a file twice in quick succession into the compose drop zone. The first upload doesn\'t get debounced and both attempts complete, so the attachment shows up twice in the draft.</td></tr><tr><td style="padding-top:16px"><a href="https://linear.app/bulwark/issue/BUL-2031" style="background:#5e6ad2;color:#fff;padding:8px 16px;text-decoration:none;border-radius:6px;font-size:13px">Open in Linear</a></td></tr></table>',
      ),
      messageId: '<BUL-2031-assign@linear.app>',
    },

    // Anna - sister, photos
    {
      id: 'demo-email-anna',
      threadId: 'demo-thread-anna',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 4800000,
      receivedAt: demoDate(-1, -19),
      from: [{ name: 'Anna Kowalski', email: 'anna.kowalski@example.com' }],
      to: [USER],
      subject: 'photos from the wedding',
      sentAt: demoDate(-1, -19),
      preview: "finally got around to going through these. there are like 600 more on the drive but here's the highlights...",
      hasAttachment: true,
      ...textOnly(
        "ok finally got around to going through these. there are like 600 more on the drive but here's the highlights - the ones I'd actually want to print.\n\nmom looked SO happy. dad cried during the speech btw, did you see?\n\nlet me know which ones you want full-res of\n\na",
      ),
      attachments: [
        { partId: 'att-3', blobId: 'demo-blob-att-3', size: 170392, name: 'wedding-001.jpg', type: 'image/jpeg' },
        { partId: 'att-4', blobId: 'demo-blob-att-4', size: 154740, name: 'wedding-014-mom-dad.jpg', type: 'image/jpeg' },
        { partId: 'att-5', blobId: 'demo-blob-att-5', size: 133897, name: 'wedding-038-the-toast.jpg', type: 'image/jpeg' },
      ],
      messageId: '<wedding-photos@example.com>',
    },

    // AWS billing
    {
      id: 'demo-email-aws',
      threadId: 'demo-thread-aws',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 9100,
      receivedAt: demoDate(-2, -3, -45),
      from: [{ name: 'AWS Billing', email: 'no-reply-aws@amazon.com' }],
      to: [USER],
      subject: 'Your AWS bill is available - $127.43',
      sentAt: demoDate(-2, -3, -45),
      preview: 'Your bill for the previous billing period is now available. Total this period: $127.43 (down $4.12)...',
      hasAttachment: false,
      ...textOnly(
        "Your bill for the previous billing period is now available.\n\nTotal this period: $127.43 (down $4.12 from last period)\n\nTop services:\n  EC2 - $61.20\n  S3 - $28.94\n  Route 53 - $14.50\n  CloudFront - $11.02\n  Other - $11.77\n\nView the full invoice in the Billing Console.",
      ),
      messageId: '<aws-bill-2024-11@amazon.com>',
    },

    // 2FA code - system, unread
    {
      id: 'demo-email-2fa',
      threadId: 'demo-thread-2fa',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 1700,
      receivedAt: demoDate(0, -1, -8),
      from: [{ name: '1Password', email: 'noreply@1password.com' }],
      to: [USER],
      subject: 'Your one-time verification code is 814-302',
      sentAt: demoDate(0, -1, -8),
      preview: "Use this code within 10 minutes to sign in. If you didn't request it, ignore this email.",
      hasAttachment: false,
      ...textOnly(
        "Your verification code: 814-302\n\nUse this code within 10 minutes to sign in. If you didn't request it, you can safely ignore this email - your account remains secure.",
      ),
      messageId: '<otp-814302@1password.com>',
    },

    // LinkedIn - cold-ish
    {
      id: 'demo-email-linkedin',
      threadId: 'demo-thread-linkedin',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 8200,
      receivedAt: demoDate(-3, -11),
      from: [{ name: 'LinkedIn', email: 'jobs-noreply@linkedin.com' }],
      to: [USER],
      subject: '5 jobs matching "staff engineer · remote · eu" - including one at Datadog',
      sentAt: demoDate(-3, -11),
      preview: "We thought you'd be interested in these jobs based on your profile and search history.",
      hasAttachment: false,
      ...textOnly(
        'Based on your saved search "staff engineer · remote · eu":\n\n1. Staff Software Engineer - Datadog (Remote, EU)\n2. Principal Engineer, Platform - Sentry (Remote, EU)\n3. Staff Backend Engineer - Linear (Remote)\n4. Tech Lead, Infrastructure - Tailscale (Remote, EU)\n5. Staff Engineer, Mobile - Notion (Remote, EU)\n\nManage job alerts at linkedin.com/jobs/preferences.',
      ),
      messageId: '<jobs-1107@linkedin.com>',
    },

    // Book club - Marcus
    {
      id: 'demo-email-bookclub',
      threadId: 'demo-thread-bookclub',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 2400,
      receivedAt: demoDate(-1, -14),
      from: [{ name: 'Marcus Hughes', email: 'marcus.hughes@example.com' }],
      to: [USER, { name: 'Emma Wilson', email: 'emma.wilson@example.com' }, { name: 'David Park', email: 'david.park@example.com' }],
      subject: 'book club thursday - picking the next one',
      sentAt: demoDate(-1, -14),
      preview: 'Reminder: 7pm at mine. We finish off Le Guin and pick the next read. My vote is the Calvino but I know Emma...',
      hasAttachment: false,
      ...textOnly(
        "Reminder: 7pm at mine. We finish off Le Guin and pick the next read.\n\nMy vote is the Calvino but I know Emma's been pushing for the Knausgaard. I'll bring wine, can someone else handle snacks?\n\nm",
      ),
      messageId: '<bookclub-nov@example.com>',
    },

    // DHL package
    {
      id: 'demo-email-dhl',
      threadId: 'demo-thread-dhl',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 5600,
      receivedAt: demoDate(0, -9, -30),
      from: [{ name: 'DHL Express', email: 'noreply@dhl.com' }],
      to: [USER],
      subject: 'Your package is out for delivery - arriving today',
      sentAt: demoDate(0, -9, -30),
      preview: 'Tracking 1Z 999 AA1 0123 4567 84 · Estimated delivery: today between 14:00 and 18:00.',
      hasAttachment: false,
      ...textOnly(
        'Your package is on the truck.\n\nTracking: 1Z 999 AA1 0123 4567 84\nEstimated delivery window: today, 14:00–18:00\n\nIf no one is home, the driver will attempt redelivery tomorrow or leave it at the nearest pickup point.\n\nTrack live at dhl.com/track.',
      ),
      messageId: '<delivery-1Z999AA1@dhl.com>',
    },

    // Notion
    {
      id: 'demo-email-notion',
      threadId: 'demo-thread-notion',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 4100,
      receivedAt: demoDate(-2, -16),
      from: [{ name: 'Olivia Bennett (via Notion)', email: 'team@mail.notion.so' }],
      to: [USER],
      subject: 'Olivia shared "Q1 2026 - design north star" with you',
      sentAt: demoDate(-2, -16),
      preview: 'Olivia Bennett shared a page with you in the Northwind workspace. Open in Notion to view.',
      hasAttachment: false,
      ...textOnly(
        'Olivia Bennett shared a page with you in the Northwind workspace.\n\n"Q1 2026 - design north star"\n\nOpen in Notion: https://notion.so/northwind/q1-design-north-star',
      ),
      messageId: '<share-northwind-q1@mail.notion.so>',
    },

    // Spotify wrap
    {
      id: 'demo-email-spotify',
      threadId: 'demo-thread-spotify',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 7400,
      receivedAt: demoDate(-4, -8),
      from: [{ name: 'Spotify', email: 'no-reply@spotify.com' }],
      to: [USER],
      subject: 'Your year in music is ready',
      sentAt: demoDate(-4, -8),
      preview: 'You spent 38,420 minutes listening this year. Your top artist was Big Thief, and your top genre was indie folk.',
      hasAttachment: false,
      ...textOnly(
        'Your year, in music.\n\n38,420 minutes listened\nTop artist: Big Thief\nTop song: "Vampire Empire"\nTop genre: indie folk\nDiscover Weekly hit rate: 41%\n\nOpen Spotify to see your full Wrapped.',
      ),
      messageId: '<wrapped-2025@spotify.com>',
    },

    // Booking.com confirmation
    {
      id: 'demo-email-booking',
      threadId: 'demo-thread-booking',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 32100,
      receivedAt: demoDate(-5, -10),
      from: [{ name: 'Booking.com', email: 'no-reply@booking.com' }],
      to: [USER],
      subject: 'Confirmation 4892-7714-3320 - Hotel Lago, Lake Como (Dec 22–25)',
      sentAt: demoDate(-5, -10),
      preview: 'Your booking is confirmed. Check-in: Dec 22, after 15:00. Check-out: Dec 25, before 11:00.',
      hasAttachment: true,
      ...textOnly(
        'Your booking is confirmed.\n\nHotel Lago, Lake Como (Italy)\nCheck-in: Dec 22, after 15:00\nCheck-out: Dec 25, before 11:00\n\nRoom: Lake-view double, breakfast included\nTotal: €612 (paid)\n\nConfirmation number: 4892-7714-3320\n\nYour voucher is attached. Show it at reception.',
      ),
      attachments: [
        { partId: 'att-6', blobId: 'demo-blob-att-6', size: 31000, name: 'booking-voucher-4892-7714-3320.pdf', type: 'application/pdf' },
      ],
      messageId: '<conf-4892-7714-3320@booking.com>',
    },

    // Substack post
    {
      id: 'demo-email-substack',
      threadId: 'demo-thread-substack',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: { $seen: true },
      size: 22400,
      receivedAt: demoDate(-1, -12),
      from: [{ name: 'Robin Sloan', email: 'robin@substack.com' }],
      to: [USER],
      subject: 'a small newsletter about a small forge',
      sentAt: demoDate(-1, -12),
      preview: 'I have been spending the slow weeks of November in the workshop, slowly forging a knife from a piece of...',
      hasAttachment: false,
      ...textOnly(
        "Hello, friends.\n\nI have been spending the slow weeks of November in the workshop, slowly forging a knife from a piece of railway track. It is going badly, in the way that is good for one's soul.\n\nWhat I'm reading: Annie Dillard, again. \"The Writing Life\". Specifically the chapter about her cabin, which I read every year around this time and which always makes me want to throw my laptop into the sea.\n\nWhat I'm watching: very little. There is something about December that makes television feel like an admission of defeat.\n\nUntil next month -\nR.",
      ),
      messageId: '<nov-2025@robin.substack.com>',
    },

    // Recruiter cold outreach
    {
      id: 'demo-email-recruiter',
      threadId: 'demo-thread-recruiter',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 3200,
      receivedAt: demoDate(0, -10),
      from: [{ name: 'Jennifer Hayes', email: 'jennifer@talent-partners.example' }],
      to: [USER],
      subject: 'Senior role - Distributed Systems - €180-220k + equity',
      sentAt: demoDate(0, -10),
      preview: "Hi, I came across your profile and thought you'd be a great fit for a senior position with one of our clients...",
      hasAttachment: false,
      ...textOnly(
        "Hi,\n\nI came across your profile and thought you'd be a great fit for a senior position with one of our clients - a well-funded Series B (real-time data infrastructure, 60-person eng team, fully remote within EU).\n\nThe core stack: Rust + Postgres + a non-trivial amount of Go. Hiring level is roughly equivalent to Staff at FAANG.\n\nWould you be open to a 15-minute call this week or next?\n\nBest,\nJennifer Hayes\nTalent Partners",
      ),
      messageId: '<outreach-jh-2025-11@talent-partners.example>',
    },

    // Dentist reminder
    {
      id: 'demo-email-dentist',
      threadId: 'demo-thread-dentist',
      mailboxIds: { 'demo-mailbox-inbox': true },
      keywords: {},
      size: 2200,
      receivedAt: demoDate(-1, -2),
      from: [{ name: "Dr. Smith's Office", email: 'appointments@drsmith.example' }],
      to: [USER],
      subject: 'Appointment reminder - Tuesday at 10:00',
      sentAt: demoDate(-1, -2),
      preview: 'This is a friendly reminder of your upcoming cleaning appointment on Tuesday at 10:00 AM.',
      hasAttachment: false,
      ...textOnly(
        "Hello,\n\nThis is a friendly reminder of your upcoming cleaning appointment on Tuesday at 10:00 AM with Dr. Smith.\n\nLocation: 123 Medical Plaza, Suite 4\n\nNeed to reschedule? Reply to this email or call (555) 010-7878.\n\nSee you Tuesday!\nDr. Smith's office",
      ),
      messageId: '<appt-reminder-dr-smith@drsmith.example>',
    },

    // ── Sent ────────────────────────────────────────────────────
    {
      id: 'demo-email-6',
      threadId: 'demo-thread-6',
      mailboxIds: { 'demo-mailbox-sent': true },
      keywords: { $seen: true },
      size: 2100,
      receivedAt: demoDate(-1, -4),
      from: [USER],
      to: [{ name: 'Alice Johnson', email: 'alice.johnson@example.com' }],
      subject: 'Updated Requirements Document',
      sentAt: demoDate(-1, -4),
      preview: "Hi Alice, I've updated the requirements document with the changes we discussed...",
      hasAttachment: false,
      ...textOnly(
        "Hi Alice,\n\nI've updated the requirements document with the changes we discussed in yesterday's meeting. The main updates are in sections 3 and 5.\n\nLet me know if you have any questions.\n\nBest,\nDemo User",
      ),
      messageId: '<sent-1@example.com>',
    },
    {
      id: 'demo-email-7',
      threadId: 'demo-thread-7',
      mailboxIds: { 'demo-mailbox-sent': true },
      keywords: { $seen: true },
      size: 1800,
      receivedAt: demoDate(-4, -2),
      from: [USER],
      to: [{ name: 'Sarah Kim', email: 'sarah.kim@example.com' }],
      subject: 'Re: Design Feedback',
      sentAt: demoDate(-4, -2),
      preview: 'Thanks Sarah! The new color scheme looks great. I especially like the contrast improvements...',
      hasAttachment: false,
      ...textOnly(
        "Thanks Sarah! The new color scheme looks great. I especially like the contrast improvements for accessibility.\n\nLet's go with Option B for the navigation.\n\nBest,\nDemo User",
      ),
      messageId: '<sent-2@example.com>',
    },
    {
      id: 'demo-email-sent-mom',
      threadId: 'demo-thread-mom',
      mailboxIds: { 'demo-mailbox-sent': true },
      keywords: { $seen: true },
      size: 1400,
      receivedAt: demoDate(0, -2, -10),
      from: [USER],
      to: [{ name: 'Sofia Russo', email: 'sofia.russo@example.com' }],
      subject: 'Re: when are you coming home?',
      sentAt: demoDate(0, -2, -10),
      preview: "Mom - I miss you too. Let me check the calendar tonight and I'll get back to you tomorrow about the weekend...",
      hasAttachment: false,
      ...textOnly(
        "Mom - I miss you too. Let me check the calendar tonight and I'll get back to you tomorrow about the weekend. Lemons sound like a bribe and I will not pretend otherwise.\n\nLove you both.",
      ),
      messageId: '<re-mom-1@example.com>',
      inReplyTo: ['<5a8c-mom@example.com>'],
      references: ['<5a8c-mom@example.com>'],
    },

    // ── Drafts ──────────────────────────────────────────────────
    {
      id: 'demo-email-8',
      threadId: 'demo-thread-8',
      mailboxIds: { 'demo-mailbox-drafts': true },
      keywords: { $seen: true, $draft: true },
      size: 900,
      receivedAt: demoDate(0, -1),
      from: [USER],
      to: [{ name: 'Bob Chen', email: 'bob.chen@example.com' }],
      subject: 'Meeting Notes - Draft',
      sentAt: demoDate(0, -1),
      preview: "Here are the notes from today's standup...",
      hasAttachment: false,
      ...textOnly(
        "Here are the notes from today's standup:\n\n- API integration on track\n- Need to resolve the caching issue\n- ",
      ),
      messageId: '<draft-1@example.com>',
    },
    {
      id: 'demo-email-draft-recruiter',
      threadId: 'demo-thread-draft-recruiter',
      mailboxIds: { 'demo-mailbox-drafts': true },
      keywords: { $seen: true, $draft: true },
      size: 720,
      receivedAt: demoDate(0, -8),
      from: [USER],
      to: [{ name: 'Jennifer Hayes', email: 'jennifer@talent-partners.example' }],
      subject: 'Re: Senior role - Distributed Systems',
      sentAt: demoDate(0, -8),
      preview: "Hi Jennifer, thanks for reaching out. I'm not actively looking, but the role sounds interesting enough that...",
      hasAttachment: false,
      ...textOnly(
        "Hi Jennifer,\n\nThanks for reaching out. I'm not actively looking, but the role sounds interesting enough that I'd be open to a quick call. A few questions before we set something up:\n\n- ",
      ),
      messageId: '<draft-recruiter@example.com>',
    },

    // ── Trash ───────────────────────────────────────────────────
    {
      id: 'demo-email-9',
      threadId: 'demo-thread-9',
      mailboxIds: { 'demo-mailbox-trash': true },
      keywords: { $seen: true },
      size: 15200,
      receivedAt: demoDate(-5, -3),
      from: [{ name: 'Promo Store', email: 'deals@promostore.example' }],
      to: [USER],
      subject: '🎉 Flash Sale: 50% Off Everything!',
      sentAt: demoDate(-5, -3),
      preview: 'Limited time offer! Get 50% off all items in our store...',
      hasAttachment: false,
      ...textOnly(
        'Limited time offer! Get 50% off all items in our store. Use code FLASH50 at checkout.',
      ),
      messageId: '<promo-1@promostore.example>',
    },
    {
      id: 'demo-email-10',
      threadId: 'demo-thread-10',
      mailboxIds: { 'demo-mailbox-trash': true },
      keywords: { $seen: true },
      size: 2300,
      receivedAt: demoDate(-7, 0),
      from: [{ name: 'System Notification', email: 'noreply@service.example' }],
      to: [USER],
      subject: 'Your password was changed',
      sentAt: demoDate(-7, 0),
      preview: 'Your account password was successfully changed on...',
      hasAttachment: false,
      ...textOnly(
        'Your account password was successfully changed. If you did not make this change, please contact support immediately.',
      ),
      messageId: '<notification-1@service.example>',
    },

    // ── Projects ────────────────────────────────────────────────
    {
      id: 'demo-email-11',
      threadId: 'demo-thread-11',
      mailboxIds: { 'demo-mailbox-projects': true },
      keywords: { $seen: true, $flagged: true },
      size: 4500,
      receivedAt: demoDate(-2, -7),
      from: [{ name: 'Alice Johnson', email: 'alice.johnson@example.com' }],
      to: [USER],
      subject: '[Project] Sprint Planning Agenda',
      sentAt: demoDate(-2, -7),
      preview: "Here's the agenda for next week's sprint planning session...",
      hasAttachment: false,
      ...textOnly(
        "Hi team,\n\nHere's the agenda for next week's sprint planning:\n\n1. Review previous sprint velocity\n2. Discuss tech debt items\n3. Prioritize backlog\n4. Assign story points\n5. Capacity planning\n\nPlease come prepared with your updates.\n\nThanks,\nAlice",
      ),
      messageId: '<project-1@example.com>',
    },
    {
      id: 'demo-email-12',
      threadId: 'demo-thread-12',
      mailboxIds: { 'demo-mailbox-projects': true },
      keywords: {},
      size: 3200,
      receivedAt: demoDate(0, -8),
      from: [{ name: 'Bob Chen', email: 'bob.chen@example.com' }],
      to: [USER],
      subject: '[Project] API Rate Limiting Discussion',
      sentAt: demoDate(0, -8),
      preview: "I've been thinking about our rate limiting approach and wanted to propose a few changes...",
      hasAttachment: false,
      ...textOnly(
        "Hey,\n\nI've been thinking about our rate limiting approach and wanted to propose:\n\n1. Token bucket algorithm instead of fixed window\n2. Per-endpoint limits rather than global\n3. Graduated response (warn → throttle → block)\n\nThoughts? I can put together a more detailed RFC if we agree on the direction.\n\n- Bob",
      ),
      messageId: '<project-2@example.com>',
    },
    {
      id: 'demo-email-roadmap',
      threadId: 'demo-thread-roadmap',
      mailboxIds: { 'demo-mailbox-projects': true },
      keywords: {},
      size: 4900,
      receivedAt: demoDate(-1, -15),
      from: [{ name: 'Michael Torres', email: 'michael.torres@company.example' }],
      to: [USER, { name: 'Alice Johnson', email: 'alice.johnson@example.com' }, { name: 'James Miller', email: 'james.miller@company.example' }],
      subject: '[Project] Q1 2026 roadmap - first cut',
      sentAt: demoDate(-1, -15),
      preview: 'Attached is the first cut of the Q1 roadmap. Three themes: reliability, mobile, and the long-promised...',
      hasAttachment: true,
      ...textOnly(
        "Team,\n\nAttached is the first cut of the Q1 roadmap. Three themes:\n\n1. Reliability (Alice's team)\n2. Mobile parity (cross-functional)\n3. The long-promised search rework (James, this is mostly on you)\n\nLet's leave comments in the doc rather than do a meeting - I'd rather have the meeting be the *decisions*, not the discussion. Closing comments end-of-week.\n\nM",
      ),
      attachments: [
        { partId: 'att-7', blobId: 'demo-blob-att-7', size: 84000, name: 'Q1-2026-roadmap-v0.pdf', type: 'application/pdf' },
      ],
      messageId: '<roadmap-q1-2026@company.example>',
    },

    // ── Archive ─────────────────────────────────────────────────
    {
      id: 'demo-email-13',
      threadId: 'demo-thread-13',
      mailboxIds: { 'demo-mailbox-archive': true },
      keywords: { $seen: true },
      size: 2600,
      receivedAt: demoDate(-14, -6),
      from: [{ name: 'Maria Lopez', email: 'maria.lopez@company.example' }],
      to: [USER],
      subject: 'Updated PTO Policy - Effective January 1',
      sentAt: demoDate(-14, -6),
      preview: 'Please review the updated PTO policy that takes effect January 1st...',
      hasAttachment: false,
      ...textOnly(
        'Dear team,\n\nPlease review the updated PTO policy effective January 1st. Key changes include:\n\n- Increased annual allowance from 20 to 25 days\n- Flexible half-day options\n- Rollover limit increased to 10 days\n\nPlease acknowledge receipt.\n\nBest,\nMaria - People Ops',
      ),
      messageId: '<hr-policy-1@company.example>',
    },
    {
      id: 'demo-email-archive-support',
      threadId: 'demo-thread-archive-support',
      mailboxIds: { 'demo-mailbox-archive': true },
      keywords: { $seen: true },
      size: 3400,
      receivedAt: demoDate(-21, -4),
      from: [{ name: 'Fastmail Support', email: 'support@fastmail.com' }],
      to: [USER],
      subject: 'Re: Ticket #438201 - DKIM signing fails on cross-account aliases',
      sentAt: demoDate(-21, -4),
      preview: "Thanks for the additional logs. We were able to reproduce on our side - the issue was indeed the alias resolution...",
      hasAttachment: false,
      ...textOnly(
        "Hi,\n\nThanks for the additional logs. We were able to reproduce on our side - the issue was indeed the alias resolution path skipping the DKIM signer step. Fix has been deployed to the AU and SY clusters; EU rolls out tomorrow.\n\nResolved on our end. Please reopen if you see anything related.\n\nBest,\nClaire - Fastmail Support",
      ),
      messageId: '<ticket-438201-resolved@fastmail.com>',
    },

    // ── Receipts ────────────────────────────────────────────────
    {
      id: 'demo-email-14',
      threadId: 'demo-thread-14',
      mailboxIds: { 'demo-mailbox-receipts': true },
      keywords: { $seen: true },
      size: 5200,
      receivedAt: demoDate(-3, -12),
      from: [{ name: 'Hetzner', email: 'billing@hetzner.com' }],
      to: [USER],
      subject: 'Invoice #INV-2024-1042 - €49.99 (paid)',
      sentAt: demoDate(-3, -12),
      preview: 'Your payment of €49.99 has been processed successfully...',
      hasAttachment: true,
      ...textOnly(
        'Payment Confirmation\n\nAmount: €49.99\nDate: 3 days ago\nInvoice: INV-2024-1042\nService: CX22 dedicated (Helsinki, monthly)\n\nThank you for your payment.',
      ),
      attachments: [
        { partId: 'att-8', blobId: 'demo-blob-att-8', size: 28000, name: 'INV-2024-1042.pdf', type: 'application/pdf' },
      ],
      messageId: '<receipt-1@hetzner.com>',
    },
    {
      id: 'demo-email-receipts-domain',
      threadId: 'demo-thread-receipts-domain',
      mailboxIds: { 'demo-mailbox-receipts': true },
      keywords: { $seen: true },
      size: 3100,
      receivedAt: demoDate(-9, -8),
      from: [{ name: 'Porkbun', email: 'support@porkbun.com' }],
      to: [USER],
      subject: 'Renewal confirmation - example.com (1 year)',
      sentAt: demoDate(-9, -8),
      preview: 'Your domain example.com has been renewed for 1 year. Next renewal: 11 months from today.',
      hasAttachment: false,
      ...textOnly(
        "Hi,\n\nYour domain example.com has been renewed for 1 year.\n\nAmount: $11.06\nNext renewal: 11 months from today\nAutorenew: on\n\nReply to this email if you need a tax-receipt-style invoice.\n\n- Porkbun",
      ),
      messageId: '<renewal-example.com@porkbun.com>',
    },

    // ── Spam ────────────────────────────────────────────────────
    {
      id: 'demo-email-15',
      threadId: 'demo-thread-15',
      mailboxIds: { 'demo-mailbox-junk': true },
      keywords: {},
      size: 8900,
      receivedAt: demoDate(-1, -9),
      from: [{ name: 'Prize Center', email: 'winner@totallylegit.example' }],
      to: [USER],
      subject: 'Congratulations! You Won $1,000,000!!!',
      sentAt: demoDate(-1, -9),
      preview: 'Dear lucky winner, you have been selected to receive one million dollars...',
      hasAttachment: false,
      ...textOnly(
        'Dear lucky winner,\n\nYou have been selected to receive ONE MILLION DOLLARS! Click below to claim your prize immediately.\n\n[This is a demo spam email]',
      ),
      messageId: '<spam-1@totallylegit.example>',
    },
    {
      id: 'demo-email-spam-phish',
      threadId: 'demo-thread-spam-phish',
      mailboxIds: { 'demo-mailbox-junk': true },
      keywords: {},
      size: 4600,
      receivedAt: demoDate(-2, -3),
      from: [{ name: 'Secure Banking', email: 'security-alert@secur1ty-bank.example' }],
      to: [USER],
      subject: 'URGENT: Unusual activity on your account - verify within 24 hours',
      sentAt: demoDate(-2, -3),
      preview: "We've detected suspicious activity. Click below to verify your identity or your account will be suspended...",
      hasAttachment: false,
      ...textOnly(
        "We've detected suspicious activity on your account. To prevent suspension, please verify your details within 24 hours by clicking the link below.\n\n[Phishing demo - never click links like this in real life.]",
      ),
      messageId: '<phish-1@secur1ty-bank.example>',
    },
    {
      id: 'demo-email-spam-crypto',
      threadId: 'demo-thread-spam-crypto',
      mailboxIds: { 'demo-mailbox-junk': true },
      keywords: {},
      size: 6800,
      receivedAt: demoDate(-3, -19),
      from: [{ name: 'CryptoGrowth Daily', email: 'invest@cryptogrowth.example' }],
      to: [USER],
      subject: '🚀 The coin Elon won\'t tell you about - 1000x potential',
      sentAt: demoDate(-3, -19),
      preview: 'Three early backers turned $500 into $5M in 90 days. Today, you have a chance to get in even earlier...',
      hasAttachment: false,
      ...textOnly(
        'Three early backers turned $500 into $5M in 90 days. Today, you have a chance to get in even earlier. Limited spots. No experience needed.\n\n[Demo spam.]',
      ),
      messageId: '<spam-crypto@cryptogrowth.example>',
    },
  ];
}
