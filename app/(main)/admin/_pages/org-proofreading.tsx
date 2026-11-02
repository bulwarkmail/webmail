'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { ProofreadingSection } from '@/components/admin/org/sections/proofreading-section';

export function OrgProofreadingPage() {
  const draft = useOrgPolicyDraft('org-proofreading');
  return (
    <OrgPage pageId="org-proofreading" draft={draft}>
      <ProofreadingSection draft={draft} />
    </OrgPage>
  );
}
