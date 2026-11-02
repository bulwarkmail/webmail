'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { TemplatesSection } from '@/components/admin/org/sections/templates-section';
import { VacationTemplatesSection } from '@/components/admin/org/sections/vacation-templates-section';

export function OrgTemplatesPage() {
  const draft = useOrgPolicyDraft('org-templates');
  return (
    <OrgPage pageId="org-templates" draft={draft}>
      <TemplatesSection draft={draft} />
      <VacationTemplatesSection draft={draft} />
    </OrgPage>
  );
}
