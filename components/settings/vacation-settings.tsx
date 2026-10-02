'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from './settings-section';
import { Button } from '@/components/ui/button';
import { RichTextEditor } from '@/components/email/rich-text-editor';
import { VacationFiltersError, useVacationStore, type VacationForwardSettings } from '@/stores/vacation-store';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useManagedAccountStore } from '@/stores/managed-account-store';
import type { VacationForward } from '@/lib/jmap/sieve-types';
import { isPeriodBoundary } from '@/lib/sieve/period';
import { ownDomains } from '@/lib/sieve/vacation-audience';
import { sanitizeEmailHtml } from '@/lib/email-sanitization';
import { htmlToPlainText } from '@/lib/html-to-text';
import { isValidEmail } from '@/lib/validation';
import { Loader2, AlertTriangle, Eye, EyeOff } from '@/components/icons';
import { toast } from '@/stores/toast-store';

const STALWART_VACATION_LIMITS = { subject: 511, body: 2047 };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A switch with its state written out next to it ("Active" / "Inactive"). */
function StatusSwitch({ checked, onChange, activeLabel, inactiveLabel }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
        checked
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-muted text-muted-foreground'
      }`}>
        {checked ? activeLabel : inactiveLabel}
      </span>
      <ToggleSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

function utcToLocalDatetime(utcIso: string): string {
  const d = new Date(utcIso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The latest moment the date fields offer: a later year has no room in the
// four digits a stored date has.
const DATE_INPUT_MAX = '9999-12-31T23:59';

/**
 * The moment a date field holds: '' when it is empty, null when it holds none
 * that can be stored (a five-digit year). A field left as it was loaded keeps
 * the stored value exactly.
 */
function fieldMoment(input: string, stored: string | null): string | null {
  if (!input) return '';
  if (stored && input === utcToLocalDatetime(stored)) return stored;
  const moment = new Date(input);
  if (Number.isNaN(moment.getTime())) return null;
  const iso = moment.toISOString();
  return isPeriodBoundary(iso) ? iso : null;
}

function sameForward(a: VacationForwardSettings | null, b: VacationForward | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.to === b.to && a.keepCopy === b.keepCopy;
}

export function VacationSettings() {
  const t = useTranslations('settings.vacation');
  const tFilters = useTranslations('settings.filters');
  const tNotifications = useTranslations('notifications');
  const { client } = useAuthStore();
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  // What is typed here belongs to the account it was typed for: on a switch
  // the fields start over, even where both accounts store the same values.
  const accountKey = `${activeAccountId ?? ''}/${managedAccountId ?? ''}`;
  const {
    isEnabled,
    fromDate,
    toDate,
    subject,
    textBody,
    htmlBody,
    forward,
    forwardAvailable,
    audience,
    audienceAvailable,
    notRunning,
    otherForwards,
    isLoading,
    isSaving,
    error,
    isSupported,
    fetchVacationResponse,
    updateVacationResponse,
  } = useVacationStore();

  const [localEnabled, setLocalEnabled] = useState(isEnabled);
  // The date fields as typed ("yyyy-mm-ddThh:mm" on the browser's clock).
  const [fromInput, setFromInput] = useState(() => (fromDate ? utcToLocalDatetime(fromDate) : ''));
  const [toInput, setToInput] = useState(() => (toDate ? utcToLocalDatetime(toDate) : ''));
  // A field the browser holds half filled in (a date without its time) reads
  // as empty, without an event when it was empty before: told apart here, so
  // it does not pass for "no date", which leaves that end of the period open.
  const [halfFilled, setHalfFilled] = useState({ from: false, to: false });
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const localFromDate = fieldMoment(fromInput, fromDate);
  const localToDate = fieldMoment(toInput, toDate);
  const datesUnusable = localFromDate === null || localToDate === null || halfFilled.from || halfFilled.to;
  const [localSubject, setLocalSubject] = useState(subject);
  const [localTextBody, setLocalTextBody] = useState(textBody);
  const [htmlEnabled, setHtmlEnabled] = useState(!!htmlBody);
  const [localHtmlBody, setLocalHtmlBody] = useState(htmlBody || '');
  const [showPreview, setShowPreview] = useState(false);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [forwardEnabled, setForwardEnabled] = useState(forward?.enabled ?? false);
  const [forwardTo, setForwardTo] = useState(forward?.to ?? '');
  const [forwardKeep, setForwardKeep] = useState(forward?.keepCopy ?? false);
  const [audienceOnly, setAudienceOnly] = useState<'all' | 'internal' | 'external'>(audience?.only ?? 'all');
  // "Internal" are the account's own domains, as its identities give them.
  const identities = useIdentityStore((s) => s.identities);
  const domains = useMemo(() => ownDomains(identities.map((i) => i.email)), [identities]);

  useEffect(() => {
    if (client && isSupported) {
      void fetchVacationResponse(client, managedAccountId ?? undefined);
    }
  }, [client, isSupported, managedAccountId, fetchVacationResponse]);

  useEffect(() => {
    setLocalEnabled(isEnabled);
    setFromInput(fromDate ? utcToLocalDatetime(fromDate) : '');
    setToInput(toDate ? utcToLocalDatetime(toDate) : '');
    setHalfFilled({ from: false, to: false });
    setLocalSubject(subject);
    setLocalTextBody(textBody);
    setHtmlEnabled(!!htmlBody);
    setLocalHtmlBody(htmlBody || '');
  }, [accountKey, isEnabled, fromDate, toDate, subject, textBody, htmlBody]);

  useEffect(() => {
    setForwardEnabled(forward?.enabled ?? false);
    setForwardTo(forward?.to ?? '');
    setForwardKeep(forward?.keepCopy ?? false);
  }, [accountKey, forward]);

  useEffect(() => {
    setAudienceOnly(audience?.only ?? 'all');
  }, [accountKey, audience]);

  // Reads a date field as the browser holds it, half filled in or not.
  const readDateField = (field: 'from' | 'to', input: HTMLInputElement) => {
    (field === 'from' ? setFromInput : setToInput)(input.value);
    const half = input.validity.badInput;
    setHalfFilled((current) => (current[field] === half ? current : { ...current, [field]: half }));
  };

  // Who gets the auto-reply as a save stores it: everyone, or the senders
  // from (or not from) the account's domains as they are now.
  const canNarrow = audienceAvailable && domains.length > 0;
  const audienceSettings = !canNarrow
    ? undefined
    : audienceOnly === 'all' ? null : { only: audienceOnly, domains };
  const audienceChanged = canNarrow && (
    audienceOnly !== (audience?.only ?? 'all') ||
    (audienceOnly !== 'all' && domains.join(',') !== (audience?.domains ?? []).join(','))
  );

  // Forwarding as a save stores it: an address that is off is kept for next
  // time if it is usable, and dropped otherwise.
  const forwardInvalid = forwardAvailable && forwardEnabled && !isValidEmail(forwardTo);
  const forwardSettings = !forwardAvailable
    ? undefined
    : forwardEnabled || isValidEmail(forwardTo)
      ? { enabled: forwardEnabled, to: forwardTo, keepCopy: forwardKeep }
      : null;
  // Only what was changed here is sent: the rest stays as the server has it,
  // which another tab or device may have changed since this one loaded.
  const forwardChanged = forwardSettings !== undefined && !sameForward(forwardSettings, forward);
  // Kept here, the message goes on through the filter rules, whose forwards
  // share the server's limit with this one.
  const forwardLimit = client?.getSieveCapabilities(managedAccountId ?? undefined)?.maxNumberRedirects;
  const forwardOverLimit =
    forwardAvailable && forwardEnabled && forwardKeep &&
    typeof forwardLimit === 'number' && forwardLimit > 0 && 1 + otherForwards > forwardLimit;

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

    if (datesUnusable) {
      warnings.push(t('warnings.invalid_date'));
    }
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

    if (forwardInvalid) {
      warnings.push(t('warnings.forward_address'));
    }
    if (forwardOverLimit) {
      warnings.push(tFilters('forward_limit', { count: forwardLimit }));
    }
    if (notRunning) {
      warnings.push(t('warnings.not_running'));
    }

    setValidationWarnings(warnings);
    return warnings;
  }, [datesUnusable, localFromDate, localToDate, localEnabled, localTextBody, htmlEnabled, localHtmlBody, oversize, sizeLimits, forwardInvalid, forwardOverLimit, forwardLimit, notRunning, t, tFilters]);

  useEffect(() => {
    validate();
  }, [validate]);

  const hasChanges =
    localEnabled !== isEnabled ||
    (localFromDate || null) !== (fromDate || null) ||
    (localToDate || null) !== (toDate || null) ||
    localSubject !== subject ||
    localTextBody !== textBody ||
    (htmlEnabled ? localHtmlBody : '') !== (htmlBody || '') ||
    forwardChanged ||
    audienceChanged ||
    // Saving sets right what is stored but does not run.
    notRunning;

  const hasBlockingError =
    datesUnusable ||
    !!(localFromDate && localToDate && new Date(localToDate) <= new Date(localFromDate)) ||
    oversize.subject || oversize.body || forwardInvalid;

  const handleSave = async () => {
    if (!client) return;
    // Half filled in without a single event: only the field itself knows.
    const half = { from: !!fromRef.current?.validity.badInput, to: !!toRef.current?.validity.badInput };
    if (half.from || half.to) {
      setHalfFilled(half);
      return;
    }
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
        forward: forwardChanged ? forwardSettings : undefined,
        audience: audienceChanged ? audienceSettings : undefined,
      }, managedAccountId ?? undefined);

      toast.success(tNotifications('vacation_saved'));
    } catch (error) {
      console.error('Failed to save vacation response:', error);
      toast.error(tNotifications(
        error instanceof VacationFiltersError ? 'vacation_filters_save_failed' : 'vacation_save_failed',
      ));
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
      {/* The period is the absence: the auto-reply and forwarding both keep to it. */}
      <SettingsSection title={t('title')} description={t('description')}>
        <SettingItem
          label={t('date_range.start')}
          description={t('date_range.start_description')}
        >
          <input
            ref={fromRef}
            type="datetime-local"
            max={DATE_INPUT_MAX}
            value={fromInput}
            onChange={(e) => readDateField('from', e.currentTarget)}
            onBlur={(e) => readDateField('from', e.currentTarget)}
            aria-invalid={localFromDate === null || halfFilled.from}
            className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
        <SettingItem
          label={t('date_range.end')}
          description={t('date_range.end_description')}
        >
          <input
            ref={toRef}
            type="datetime-local"
            max={DATE_INPUT_MAX}
            value={toInput}
            onChange={(e) => readDateField('to', e.currentTarget)}
            onBlur={(e) => readDateField('to', e.currentTarget)}
            aria-invalid={localToDate === null || halfFilled.to}
            className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('auto_reply.title')} description={t('status.description')}>
        <SettingItem label={t('status.label')}>
          <StatusSwitch
            checked={localEnabled}
            onChange={setLocalEnabled}
            activeLabel={t('status.active')}
            inactiveLabel={t('status.inactive')}
          />
        </SettingItem>
        {canNarrow && (
          <SettingItem
            label={t('audience.label')}
            description={t('audience.description', { domains: domains.join(', ') })}
          >
            <Select
              value={audienceOnly}
              onChange={(value) => setAudienceOnly(value as 'all' | 'internal' | 'external')}
              options={[
                { value: 'all', label: t('audience.all') },
                { value: 'internal', label: t('audience.internal') },
                { value: 'external', label: t('audience.external') },
              ]}
            />
          </SettingItem>
        )}
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

      {forwardAvailable && (
        <SettingsSection title={t('forward.title')} description={t('forward.description')}>
          <SettingItem label={t('forward.enabled_label')}>
            <StatusSwitch
              checked={forwardEnabled}
              onChange={setForwardEnabled}
              activeLabel={t('status.active')}
              inactiveLabel={t('status.inactive')}
            />
          </SettingItem>
          {forwardEnabled && (
            <>
              <SettingItem label={t('forward.to_label')}>
                <input
                  type="email"
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                  placeholder={t('forward.to_placeholder')}
                  aria-label={t('forward.to_label')}
                  aria-invalid={forwardInvalid}
                  className="w-64 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 hover:border-muted-foreground"
                />
              </SettingItem>
              <SettingItem label={t('forward.keep_label')} description={t('forward.keep_description')}>
                <ToggleSwitch checked={forwardKeep} onChange={setForwardKeep} />
              </SettingItem>
            </>
          )}
        </SettingsSection>
      )}

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
