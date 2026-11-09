/**
 * Files under public/demo/ with real bytes, keyed by blob id. Every
 * attachment and every file in the demo Files app points at one of these,
 * so previews show real content. The sizes are the files' byte counts; the
 * fixture test checks they match. Regenerate the generated ones with
 * `node scripts/demo-assets/generate.mjs`.
 *
 * The photos are CC0 from Wikimedia Commons ("Wedding couple (1294004)",
 * "Wedding couple (1293575)", "Men drinking", "Lake Mountain Landscape",
 * "Team members of startup"); prototype-v3.png is drawn for the demo; the
 * rest is rendered by the generator.
 *
 * beacon-security-signoff.eml is a real S/MIME signed message (detached
 * signature, multipart/signed) and .p7s its signature part. Alice's
 * certificate comes from a throwaway "Meridian Labs Test CA" made with
 * openssl for the demo; no key of it is kept here. The S/MIME plugin
 * verifies the raw message, so these bytes must never change.
 */
export interface DemoAsset {
  path: string;
  name: string;
  type: string;
  size: number;
}

export const DEMO_ASSETS = {
  'demo-blob-invoice-designco': { path: '/demo/invoice-designco-2026-089.pdf', name: 'Invoice-2026-089.pdf', type: 'application/pdf', size: 50800 },
  'demo-blob-prototype': { path: '/demo/prototype-v3.png', name: 'prototype-v3.png', type: 'image/png', size: 21864 },
  'demo-blob-hotel-voucher': { path: '/demo/hotel-voucher-lisbon.pdf', name: 'Booking-4892771433-voucher.pdf', type: 'application/pdf', size: 51467 },
  'demo-blob-boarding-pass': { path: '/demo/boarding-pass-ber-lis.pdf', name: 'Boarding-pass-LH1796.pdf', type: 'application/pdf', size: 53751 },
  'demo-blob-summit-ticket': { path: '/demo/infra-summit-ticket.pdf', name: 'Infra-Summit-ticket-IS26-SPK-01827.pdf', type: 'application/pdf', size: 93744 },
  'demo-blob-launch-plan': { path: '/demo/beacon-launch-plan-v3.pdf', name: 'Beacon-launch-plan-v3.pdf', type: 'application/pdf', size: 44032 },
  'demo-blob-hetzner-invoice': { path: '/demo/hetzner-invoice.pdf', name: 'Hetzner-R0012345678.pdf', type: 'application/pdf', size: 39366 },
  'demo-blob-quarterly-report': { path: '/demo/quarterly-report.pdf', name: 'quarterly-report.pdf', type: 'application/pdf', size: 40644 },
  'demo-blob-po-lumen': { path: '/demo/po-lumen-logistics.pdf', name: 'PO-2026-0412-Lumen-Logistics.pdf', type: 'application/pdf', size: 39255 },
  'demo-blob-soak-dashboard': { path: '/demo/beacon-soak-dashboard.png', name: 'beacon-soak-dashboard.png', type: 'image/png', size: 110149 },
  'demo-blob-book-cover': { path: '/demo/book-cover-draft.png', name: 'lemon-tree-cover-draft2.png', type: 'image/png', size: 107537 },
  'demo-blob-soak-metrics': { path: '/demo/beacon-soak-metrics.xlsx', name: 'beacon-soak-metrics.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 8731 },
  'demo-blob-budget': { path: '/demo/budget-2026.xlsx', name: 'budget-2026.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 6835 },
  'demo-blob-runbook': { path: '/demo/beacon-rollback-runbook.docx', name: 'Beacon-rollback-runbook.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 8303 },
  'demo-blob-service-agreement': { path: '/demo/service-agreement-draft.docx', name: 'service-agreement-draft.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 7787 },
  'demo-blob-launch-deck': { path: '/demo/beacon-launch-deck.pptx', name: 'Beacon-launch.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 99675 },
  'demo-blob-meeting-notes': { path: '/demo/meeting-notes.md', name: 'meeting-notes.md', type: 'text/markdown', size: 560 },
  'demo-blob-todo': { path: '/demo/todo.txt', name: 'todo.txt', type: 'text/plain', size: 275 },
  'demo-blob-wedding-1': { path: '/demo/wedding-001.jpg', name: 'wedding-001.jpg', type: 'image/jpeg', size: 170392 },
  'demo-blob-wedding-2': { path: '/demo/wedding-014-mom-dad.jpg', name: 'wedding-014-mom-dad.jpg', type: 'image/jpeg', size: 154740 },
  'demo-blob-wedding-3': { path: '/demo/wedding-038-the-toast.jpg', name: 'wedding-038-the-toast.jpg', type: 'image/jpeg', size: 133897 },
  'demo-blob-vacation': { path: '/demo/vacation.jpg', name: 'lake-como.jpg', type: 'image/jpeg', size: 91949 },
  'demo-blob-team-photo': { path: '/demo/team-photo.jpg', name: 'team-offsite.jpg', type: 'image/jpeg', size: 71066 },
  'demo-blob-security-signoff': { path: '/demo/beacon-security-signoff.eml', name: 'Beacon security review signed off.eml', type: 'message/rfc822', size: 4054 },
  'demo-blob-security-signoff-p7s': { path: '/demo/beacon-security-signoff.p7s', name: 'smime.p7s', type: 'application/pkcs7-signature', size: 1865 },
} as const satisfies Record<string, DemoAsset>;

export type DemoBlobId = keyof typeof DEMO_ASSETS;

/** An Email attachment entry for one of the assets. */
export function attachment(blobId: DemoBlobId, overrides: { name?: string; partId?: string } = {}) {
  const asset = DEMO_ASSETS[blobId];
  return {
    partId: overrides.partId ?? blobId.replace('demo-blob-', 'att-'),
    blobId,
    size: asset.size,
    name: overrides.name ?? asset.name,
    type: asset.type,
  };
}
