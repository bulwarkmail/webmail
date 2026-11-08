"use client";

// xenaxio step 119, part H: the company's groups on their own page (they were in
// the Rooms settings): one list for @mentions in Rooms, who sees object types,
// and later roles in flows. Same data as before (chat_groups).
import { GroupsAdmin } from "@/components/xenaxio/chat/groups-admin";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

export default function GroupsPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("groups_page.title")}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("groups_page.intro")}</p>
        <GroupsAdmin />
      </div>
    </WorkspaceShell>
  );
}
