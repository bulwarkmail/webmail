"use client";

// Step 23: settings for mail apps (Outlook, Apple Mail, Thunderbird, Android)
// and short set-up steps for each. Plain IMAP and SMTP with TLS; the login is
// the address and the password is the one for xenaxio.
import type { ReactNode } from "react";
import { CopyButton } from "@/components/xenaxio/copy-button";
import { Notice } from "@/components/xenaxio/ui";
import type { MailAppSettings } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

/** Apps with set-up steps, in the order shown; each has `mail_apps.<id>_1…n`. */
export const MAIL_APPS = [
  { id: "outlook", steps: 4 },
  { id: "outlook_new", steps: 3 },
  { id: "iphone", steps: 4 },
  { id: "mac", steps: 3 },
  { id: "thunderbird", steps: 4 },
  { id: "android", steps: 4 },
] as const;

/** One setting; on a phone the label sits above the value so addresses do not break. */
function Row({ label, value, copy, plain }: { label: string; value: string; copy?: boolean; plain?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <dt className="text-xs text-muted-foreground sm:w-36 sm:shrink-0 sm:text-sm">{label}</dt>
        <dd className={`break-all text-sm ${plain ? "" : "font-mono"}`}>{value}</dd>
      </div>
      {copy && <CopyButton value={value} />}
    </div>
  );
}

function Server({ title, server }: { title: string; server: MailAppSettings["imap"] }) {
  const t = useXT();
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      <dl className="divide-y divide-border rounded-lg border border-border">
        <Row label={t("mail_apps.server")} value={server.host} copy />
        <Row label={t("mail_apps.port")} value={String(server.port)} copy />
        <Row label={t("mail_apps.security")} value={t("mail_apps.security_ssl")} plain />
      </dl>
    </section>
  );
}

function Steps({ id, count }: { id: string; count: number }) {
  const t = useXT();
  const items: ReactNode[] = [];
  for (let i = 1; i <= count; i++) items.push(<li key={i}>{t(`mail_apps.${id}_${i}`)}</li>);
  return (
    <details className="group rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-4 py-3 font-medium">{t(`mail_apps.${id}`)}</summary>
      <ol className="list-decimal space-y-2 px-4 pb-4 pl-9 text-sm">{items}</ol>
    </details>
  );
}

export function MailApps({ settings, domainPending }: { settings: MailAppSettings; domainPending: boolean }) {
  const t = useXT();
  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">{t("mail_apps.intro")}</p>
      {domainPending && <Notice kind="info">{t("mail_apps.domain_pending")}</Notice>}

      <section className="space-y-2">
        <h2 className="font-medium">{t("mail_apps.account")}</h2>
        <dl className="divide-y divide-border rounded-lg border border-border">
          <Row label={t("mail_apps.username")} value={settings.username} copy />
          <Row label={t("mail_apps.password")} value={t("mail_apps.password_value")} plain />
        </dl>
        <p className="text-xs text-muted-foreground">{t("mail_apps.password_note")}</p>
      </section>

      <Server title={t("mail_apps.incoming")} server={settings.imap} />
      <Server title={t("mail_apps.outgoing")} server={settings.smtp} />
      <p className="text-xs text-muted-foreground">{t("mail_apps.outgoing_note")}</p>

      <section className="space-y-2">
        <h2 className="font-medium">{t("mail_apps.howto_title")}</h2>
        {MAIL_APPS.map((app) => (
          <Steps key={app.id} id={app.id} count={app.steps} />
        ))}
      </section>

      <p className="text-sm text-muted-foreground">{t("mail_apps.web_only")}</p>
      <p className="text-sm text-muted-foreground">{t("mail_apps.shared")}</p>
    </div>
  );
}
