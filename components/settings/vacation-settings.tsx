'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { Button } from '@/components/ui/button';
import { RichTextEditor } from '@/components/email/rich-text-editor';
import { useVacationStore } from '@/stores/vacation-store';
import { useAuthStore } from '@/stores/auth-store';
import { useManagedAccountStore } from '@/stores/managed-account-store';
import { sanitizeEmailHtml } from '@/lib/email-sanitization';
import { htmlToPlainText } from '@/lib/html-to-text';
import { Loader2, AlertTriangle, Eye, EyeOff } from '@/components/icons';
import { toast } from '@/stores/toast-store';

const STALWART_VACATION_LIMITS = { subject: 511, body: 2047 };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function utcToLocalDatetime(utcIso: string): string {
  const d = new Date(utcIso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VacationSettings() {
  const t = useTranslations('settings.vacation');
  const tNotifications = useTranslations('notifications');
  const { client } = useAuthStore();
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const {
    isEnabled,
    fromDate,
    toDate,
    subject,
    textBody,
    htmlBody,
    isLoading,
    isSaving,
    error,
    isSupported,
    fetchVacationResponse,
    updateVacationResponse,
  } = useVacationStore();

  const [localEnabled, setLocalEnabled] = useState(isEnabled);
  const [localFromDate, setLocalFromDate] = useState(fromDate || '');
  const [localToDate, setLocalToDate] = useState(toDate || '');
  const [localSubject, setLocalSubject] = useState(subject);
  const [localTextBody, setLocalTextBody] = useState(textBody);
  const [htmlEnabled, setHtmlEnabled] = useState(!!htmlBody);
  const [localHtmlBody, setLocalHtmlBody] = useState(htmlBody || '');
  const [showPreview, setShowPreview] = useState(false);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (client && isSupported) {
      void fetchVacationResponse(client, managedAccountId ?? undefined);
    }
  }, [client, isSupported, managedAccountId, fetchVacationResponse]);

  useEffect(() => {
    setLocalEnabled(isEnabled);
    setLocalFromDate(fromDate || '');
    setLocalToDate(toDate || '');
    setLocalSubject(subject);
    setLocalTextBody(textBody);
    setHtmlEnabled(!!htmlBody);
    setLocalHtmlBody(htmlBody || '');
  }, [isEnabled, fromDate, toDate, subject, textBody, htmlBody]);

  // What a save sends: the sanitized HTML and a plain-text part, derived
  // from the HTML when the user left it blank (for clients without HTML).
  const payload = useMemo(() => {
    const sanitizedHtml =
      htmlEnabled && htmlToPlainText(localHtmlBody).trim()
        ? sanitizeEmailHtml(localHtmlBody)
        : null;
    const text =
      localTextBody.trim() || !sanitizedHtml
        ? localTextBody
        : htmlToPlainText(sanitizedHtml, { paragraphSpacing: true });
    return { sanitizedHtml, textBody: text };
  }, [htmlEnabled, localHtmlBody, localTextBody]);

  // Stalwart refuses a subject of 512 bytes or more and a text or HTML body
  // of 2048 bytes or more, answering only "Field could not be set."
  const sizeLimits = client?.hasAccountCapability('urn:stalwart:jmap') ? STALWART_VACATION_LIMITS : null;
  const oversize = useMemo(() => {
    if (!sizeLimits) return { subject: false, body: false };
    return {
      subject: byteLength(localSubject) > sizeLimits.subject,
      body: byteLength(payload.textBody) > sizeLimits.body ||
        (payload.sanitizedHtml !== null && byteLength(payload.sanitizedHtml) > sizeLimits.body),
    };
  }, [sizeLimits, localSubject, payload]);

  const validate = useCallback(() => {
    const warnings: string[] = [];

    if (localFromDate && localToDate && new Date(localToDate) <= new Date(localFromDate)) {
      warnings.push(t('warnings.end_before_start'));
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (localFromDate && new Date(localFromDate) < todayStart) {
      warnings.push(t('warnings.start_in_past'));
    }

    const hasHtmlContent = htmlEnabled && !!htmlToPlainText(localHtmlBody).trim();
    if (localEnabled && !localTextBody.trim() && !hasHtmlContent) {
      warnings.push(t('warnings.empty_body'));
    }

    if (oversize.subject && sizeLimits) {
      warnings.push(t('warnings.subject_too_long', { max: sizeLimits.subject }));
    }
    if (oversize.body && sizeLimits) {
      warnings.push(t('warnings.body_too_long', { max: sizeLimits.body }));
    }

    setValidationWarnings(warnings);
    return warnings;
  }, [localFromDate, localToDate, localEnabled, localTextBody, htmlEnabled, localHtmlBody, oversize, sizeLimits, t]);

  useEffect(() => {
    validate();
  }, [validate]);

  const hasChanges =
    localEnabled !== isEnabled ||
    (localFromDate || null) !== (fromDate || null) ||
    (localToDate || null) !== (toDate || null) ||
    localSubject !== subject ||
    localTextBody !== textBody ||
    (htmlEnabled ? localHtmlBody : '') !== (htmlBody || '');

  const hasBlockingError =
    !!(localFromDate && localToDate && new Date(localToDate) <= new Date(localFromDate)) ||
    oversize.subject || oversize.body;

  const handleSave = async () => {
    if (!client) return;
    validate();
    if (hasBlockingError) return;

    const { sanitizedHtml, textBody } = payload;

    try {
      await updateVacationResponse(client, {
        isEnabled: localEnabled,
        fromDate: localFromDate || null,
        toDate: localToDate || null,
        subject: localSubject,
        textBody,
        htmlBody: sanitizedHtml,
      }, managedAccountId ?? undefined);

      toast.success(tNotifications('vacation_saved'));
    } catch (error) {
      console.error('Failed to save vacation response:', error);
      toast.error(tNotifications('vacation_save_failed'));
    }
  };

  if (!isSupported) {
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        <div className="text-sm text-muted-foreground py-4">
          {t('not_supported')}
        </div>
      </SettingsSection>
    );
  }

  if (isLoading) {
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('loading')}
        </div>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        <div className="text-sm text-red-600 dark:text-red-400 py-4">
          {t('fetch_error')}
        </div>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t('title')} description={t('description')}>
        <SettingItem
          label={t('status.label')}
          description={t('status.description')}
        >
          <div className="flex items-center gap-3">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              localEnabled
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-muted text-muted-foreground'
            }`}>
              {localEnabled ? t('status.active') : t('status.inactive')}
            </span>
            <ToggleSwitch checked={localEnabled} onChange={setLocalEnabled} />
          </div>
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('date_range.title')} description={t('date_range.description')}>
        <SettingItem
          label={t('date_range.start')}
          description={t('date_range.start_description')}
        >
          <input
            type="datetime-local"
            value={localFromDate ? utcToLocalDatetime(localFromDate) : ''}
            onChange={(e) => setLocalFromDate(e.target.value ? new Date(e.target.value).toISOString() : '')}
            className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
        <SettingItem
          label={t('date_range.end')}
          description={t('date_range.end_description')}
        >
          <input
            type="datetime-local"
            value={localToDate ? utcToLocalDatetime(localToDate) : ''}
            onChange={(e) => setLocalToDate(e.target.value ? new Date(e.target.value).toISOString() : '')}
            className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('message.title')} description={t('message.description')}>
        <SettingItem
          label={t('message.subject_label')}
          description={t('message.subject_description')}
        >
          <input
            type="text"
            value={localSubject}
            onChange={(e) => setLocalSubject(e.target.value)}
            placeholder={t('message.subject_placeholder')}
            className="w-64 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
        <div className="py-3">
          <label htmlFor="vacation-body" className="text-sm font-medium text-foreground block mb-1">
            {t('message.body_label')}
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            {t('message.body_description')}
          </p>
          <textarea
            id="vacation-body"
            value={localTextBody}
            onChange={(e) => setLocalTextBody(e.target.value)}
            placeholder={t('message.body_placeholder')}
            rows={6}
            className="w-full px-3 py-2 text-sm rounded-md bg-muted border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground resize-y"
          />
        </div>
        <SettingItem
          label={t('message.html_label')}
          description={t('message.html_description')}
        >
          <ToggleSwitch checked={htmlEnabled} onChange={setHtmlEnabled} />
        </SettingItem>
        {htmlEnabled && (
          <div className="pb-3">
            <div className="rounded-md border border-border overflow-hidden">
              <RichTextEditor
                content={localHtmlBody}
                onChange={setLocalHtmlBody}
                placeholder={t('message.html_placeholder')}
              />
            </div>
          </div>
        )}
      </SettingsSection>

      {(() => {
        const showHtmlPreview = htmlEnabled && !!htmlToPlainText(localHtmlBody).trim();
        if (!localTextBody.trim() && !showHtmlPreview) return null;
        return (
          <SettingsSection title={t('preview.title')}>
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-2 text-sm text-primary hover:underline"
            >
              {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showPreview ? t('preview.hide') : t('preview.show')}
            </button>
            {showPreview && (
              <div className="mt-3 p-4 rounded border border-border bg-background">
                {localSubject && (
                  <p className="font-medium text-foreground mb-2">{localSubject}</p>
                )}
                {showHtmlPreview ? (
                  <div
                    className="text-sm text-foreground [&_a]:text-primary [&_a]:underline"
                    // Preview renders into the app's own DOM. Intercept anchor
                    // clicks so following a link doesn't navigate the whole app
                    // away (and lose the unsaved responder), opening a new tab.
                    onClick={(e) => {
                      const anchor = (e.target as HTMLElement).closest('a');
                      if (anchor?.href) {
                        e.preventDefault();
                        window.open(anchor.href, '_blank', 'noopener,noreferrer');
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(localHtmlBody) }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{localTextBody}</p>
                )}
              </div>
            )}
          </SettingsSection>
        );
      })()}

      {validationWarnings.length > 0 && (
        <div className="space-y-2">
          {validationWarnings.map((warning, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={isSaving || !hasChanges || hasBlockingError}
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
              {t('saving')}
            </>
          ) : (
            t('save')
          )}
        </Button>
      </div>
    </div>
  );
}
