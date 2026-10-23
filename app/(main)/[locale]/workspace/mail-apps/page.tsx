"use client";

// Step 23: "Mail apps" — settings for Outlook, Apple Mail, Thunderbird, Android.
import { useEffect, useState } from "react";
import { MailApps } from "@/components/xenaxio/mail-apps";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, type MailAppSettings, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

function Content() {
  const t = useXT();
  const me = useMe();
  const [settings, setSettings] = useState<MailAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    xenaxio.mailApps().then(setSettings, (err: unknown) => setError(t(errorKey(err))));
  }, [t]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!settings) return <Spinner label={t("common.loading")} />;
  return <MailApps settings={settings} domainPending={me.domain?.status === "pending"} />;
}

export default function MailAppsPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("mail_apps.title")} backHref="/workspace">
      <Content />
    </WorkspaceShell>
  );
}
