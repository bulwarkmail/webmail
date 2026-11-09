/**
 * What the Support group keeps in its Inbox's shared metadata (JMAP
 * metadata, Stalwart 1.0; lib/jmap/bulwark-metadata.ts), by key without the
 * `org.bulwarkmail.` namespace:
 * - `tags`: the team's tag names and colours (lib/shared-tags.ts), which
 *   every member sees on the Support mail;
 * - `plugin.team-inbox`: the names behind the principal ids in the team
 *   inbox plugin's `$assigned:<id>` keywords (its src/lib/names.js shape).
 * Only the Support account has metadata in the demo; Nora's own account
 * keeps none, so her templates stay on the device.
 */
import type { KeywordDefinition } from '@/stores/settings-store';
import { SUPPORT_ACCOUNT_ID } from './mailboxes';
import { PRINCIPAL } from './directory';
import { BOB, NORA } from './people';

/** The Support team's tags, as members see them. */
export const SUPPORT_TAGS: KeywordDefinition[] = [
  { id: 'billing', label: 'Billing', color: 'green' },
  { id: 'integration', label: 'Integration', color: 'purple' },
  { id: 'accounts', label: 'Accounts', color: 'orange' },
  { id: 'bug', label: 'Bug', color: 'red' },
];

export function createDemoSharedMetadata(): Record<string, Record<string, unknown>> {
  return {
    [SUPPORT_ACCOUNT_ID]: {
      tags: { tags: Object.fromEntries(SUPPORT_TAGS.map(({ id, label, color }) => [id, { label, color }])) },
      'plugin.team-inbox': {
        v: 1,
        people: {
          [PRINCIPAL.nora]: { n: NORA.name, e: NORA.email },
          [PRINCIPAL.bob]: { n: BOB.name, e: BOB.email },
        },
      },
    },
  };
}
