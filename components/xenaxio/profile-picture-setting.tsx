"use client";

// Step 41: the own profile picture in Settings → Account (xenaxio build only).
import { SettingItem } from "@/components/settings/settings-section";
import { AvatarEditor } from "@/components/xenaxio/avatar-editor";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe, useXenaxioMeStore } from "@/lib/xenaxio/me-store";

function ProfilePicture() {
  const t = useXT();
  const me = useXenaxioMe();
  if (!me) return null;
  return (
    <SettingItem label={t("avatar.title")} description={t("avatar.intro")}>
      <AvatarEditor
        target={null}
        url={me.avatarUrl}
        name={me.user.displayName}
        email={me.user.email}
        // Keeps the setting right when the page is opened again.
        onChanged={(avatarUrl) => useXenaxioMeStore.setState((s) => (s.me ? { me: { ...s.me, avatarUrl } } : s))}
      />
    </SettingItem>
  );
}

export function ProfilePictureSetting() {
  return XENAXIO_BFF ? <ProfilePicture /> : null;
}
