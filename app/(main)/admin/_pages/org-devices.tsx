'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { DevicesSection } from '@/components/admin/org/sections/devices-section';
import { OfflineSection } from '@/components/admin/org/sections/offline-section';

export function OrgDevicesPage() {
  const draft = useOrgPolicyDraft('org-devices');
  return (
    <OrgPage pageId="org-devices" draft={draft}>
      <DevicesSection draft={draft} />
      <OfflineSection draft={draft} />
    </OrgPage>
  );
}
