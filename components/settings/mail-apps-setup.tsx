"use client";

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Loader2, Monitor } from '@/components/icons';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { fetchMailClientConfig, type MailClientConfig, type MailSocketSecurity } from '@/lib/mail-client-config';

/**
 * Settings > Security > "Use your mail in other apps": the user name, the
 * IMAP and SMTP servers with port and encryption, and the CalDAV and CardDAV
 * addresses, each with a Copy button. The values come from the mail server's
 * autoconfig document; when it has none, only the user name shows, with a
 * line saying so.
 */

function CopyRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  const t = useTranslations('uxs_wording.mail_apps');
  const tSecurity = useTranslations('settings.security');
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div data-testid="mail-apps-row">
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex rounded-lg">
        <input
          id={id}
          type="text"
          readOnly
          dir="ltr"
          value={value}
          className="py-2 px-3 block w-full min-w-0 bg-background border border-border border-e-transparent rounded-s-lg text-sm text-foreground focus:z-10 focus:border-ring"
        />
        <button
          type="button"
          onClick={copy}
          aria-label={t('copy_label', { name: label })}
          className="h-[38px] px-3 shrink-0 inline-flex items-center gap-1.5 rounded-e-lg border border-border bg-muted text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-hidden"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          <span aria-hidden="true">{copied ? tSecurity('email_client.copied') : tSecurity('email_client.copy')}</span>
        </button>
      </div>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function MailAppsSetup() {
  const t = useTranslations('uxs_wording.mail_apps');
  const tSecurity = useTranslations('settings.security');
  const client = useAuthStore((s) => s.client);
  const identities = useIdentityStore((s) => s.identities);

  const username = useMemo(() => client?.getUsername() || '', [client]);
  const serverUrl = useMemo(() => client?.getServerUrl() || '', [client]);
  // The autoconfig asks for an address; a bare login name takes the first identity's.
  const emailAddress = username.includes('@') ? username : (identities.find((i) => i.email)?.email ?? '');

  const [config, setConfig] = useState<MailClientConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!serverUrl || !emailAddress) {
      setConfig(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void fetchMailClientConfig(serverUrl, emailAddress, fetch, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setConfig(result);
      setLoading(false);
    });
    return () => controller.abort();
  }, [serverUrl, emailAddress]);

  const securityLabel = (security: MailSocketSecurity) => t(`security_${security}`);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Monitor className="w-4 h-4 text-muted-foreground" />
        <h4 data-search-label={tSecurity('email_client.title')} className="text-sm font-medium text-foreground">
          {tSecurity('email_client.title')}
        </h4>
      </div>
      <p className="text-xs text-muted-foreground">{tSecurity('email_client.description')}</p>
      <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md space-y-3">
        <CopyRow label={tSecurity('email_client.jmap_username_label')} value={config?.username || username} />
        {config?.imap && (
          <CopyRow
            label={t('imap')}
            value={config.imap.hostname}
            detail={t('port_security', { port: config.imap.port, security: securityLabel(config.imap.security) })}
          />
        )}
        {config?.smtp && (
          <CopyRow
            label={t('smtp')}
            value={config.smtp.hostname}
            detail={t('port_security', { port: config.smtp.port, security: securityLabel(config.smtp.security) })}
          />
        )}
        {config?.caldav && <CopyRow label={t('caldav')} value={config.caldav} />}
        {config?.carddav && <CopyRow label={t('carddav')} value={config.carddav} />}
        {loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" />
            {t('loading')}
          </p>
        ) : !config ? (
          <p className="text-xs text-muted-foreground" data-testid="mail-apps-not-found">{t('not_found')}</p>
        ) : null}
        <p className="text-xs text-muted-foreground pt-1">{tSecurity('email_client.password_instructions')}</p>
      </div>
    </div>
  );
}
