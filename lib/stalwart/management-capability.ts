import type { IJMAPClient } from '@/lib/jmap/client-interface';

const MANAGEMENT_CAPABILITIES = ['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'] as const;

export type ManagementCapability = typeof MANAGEMENT_CAPABILITIES[number];

/** Select from the authenticated account, never from another account or server-wide capabilities. */
export function getManagementCapability(
  client: Pick<IJMAPClient, 'getAccountId' | 'hasAccountCapability'>,
  accountId = client.getAccountId(),
): ManagementCapability | null {
  return MANAGEMENT_CAPABILITIES.find((capability) => client.hasAccountCapability?.(capability, accountId)) ?? null;
}
