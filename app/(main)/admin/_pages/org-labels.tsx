'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { LabelsSection } from '@/components/admin/org/sections/labels-section';

export function OrgLabelsPage() {
  const draft = useOrgPolicyDraft('org-labels');
  return (
    <OrgPage pageId="org-labels" draft={draft}>
      <LabelsSection draft={draft} />
    </OrgPage>
  );
}
