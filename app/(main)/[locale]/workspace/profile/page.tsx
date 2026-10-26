"use client";

// Step 41: the signed-in person's own picture, shown to colleagues in mail and calendar.
import { AvatarEditor } from "@/components/xenaxio/avatar-editor";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

function Profile() {
  const t = useXT();
  const me = useMe();
  return (
    <div className="max-w-md space-y-4">
      <p className="text-sm text-muted-foreground">{t("avatar.intro")}</p>
      <AvatarEditor target={null} url={me.avatarUrl} name={me.user.displayName} email={me.user.email} size="lg" />
      <p className="text-xs text-muted-foreground">{t("avatar.hint")}</p>
    </div>
  );
}

export default function ProfilePage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("avatar.title")} backHref="/workspace">
      <Profile />
    </WorkspaceShell>
  );
}
