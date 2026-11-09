'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { AnnouncementSection } from '@/components/admin/org/sections/announcement-section';
import { RetentionSection } from '@/components/admin/org/sections/retention-section';

export function OrgNoticesPage() {
  const draft = useOrgPolicyDraft('org-notices');
  return (
    <OrgPage pageId="org-notices" draft={draft}>
      <AnnouncementSection draft={draft} />
      <RetentionSection draft={draft} />
    </OrgPage>
  );
}
