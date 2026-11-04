'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
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
import { Loader2, AlertTriangle, Eye, EyeOff, Check } from '@/components/icons';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';
import { VacationCalendarBlock, VacationFilterWarning } from './vacation-calendar-block';
import { VacationTemplatePicker } from './vacation-template-picker';
import type { FilledVacationTemplate } from '@/lib/vacation-templates';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { companyName } from '@/lib/org/signature-state';
import { fromWallClock, getWallClock, parseLocalDateTime, resolveTimeZone } from '@/lib/timezone';
import { textToParagraphHtml } from '@/lib/text-to-paragraph-html';

const STALWART_VACATION_LIMITS = { subject: 511, body: 2047 };

// The page saves as you go, like every settings page: switches and menus at
// once, typing once it pauses.
const SAVE_AT_ONCE = 0;
const SAVE_AFTER_TYPING = 800;

/** The plain-text part a save derives from the sanitized HTML. */
function textFromHtml(sanitizedHtml: string): string {
  return htmlToPlainText(sanitizedHtml, { paragraphSpacing: true });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Whether HTML holds any text a recipient would read. */
function hasReadableText(html: string | null | undefined): boolean {
  return !!html && !!htmlToPlainText(html).trim();
}

/** A reply the server holds with nothing in it: off, no subject, no message. */
function isBlankReply(stored: { isEnabled: boolean; subject: string; textBody: string; htmlBody: string | null }): boolean {
  return !stored.isEnabled && !stored.subject.trim() && !stored.textBody.trim() && !hasReadableText(stored.htmlBody);
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

/** A stored moment as the date field shows it: the wall clock in the user's time zone (Settings > Language and region). */
function utcToLocalDatetime(utcIso: string, timeZone: string): string {
  const w = getWallClock(new Date(utcIso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

const DATE_FIELD =
  'max-w-full px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground';

// The latest moment the date fields offer: a later year has no room in the
// four digits a stored date has.
const DATE_INPUT_MAX = '9999-12-31T23:59';

/**
 * The moment a date field holds: '' when it is empty, null when it holds none
 * that can be stored (a five-digit year). A field left as it was loaded keeps
 * the stored value exactly.
 */
function fieldMoment(input: string, stored: string | null, timeZone: string): string | null {
  if (!input) return '';
  if (stored && input === utcToLocalDatetime(stored, timeZone)) return stored;
  const wall = parseLocalDateTime(input);
  if (!wall) return null;
  const moment = fromWallClock(wall, timeZone);
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
  const tx = useTranslations('uxs_vacation');
  const tFilters = useTranslations('settings.filters');
  const tNotifications = useTranslations('notifications');
  const locale = useLocale();
  // The dates are typed and shown in the user's time zone, which may differ from the browser's.
  const timeZoneSetting = useSettingsStore((s) => s.timeZone);
  const timeZone = useMemo(() => resolveTimeZone(timeZoneSetting), [timeZoneSetting]);
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
  const [fromInput, setFromInput] = useState(() => (fromDate ? utcToLocalDatetime(fromDate, timeZone) : ''));
  const [toInput, setToInput] = useState(() => (toDate ? utcToLocalDatetime(toDate, timeZone) : ''));
  // The zone the fields' wall-clock text is in. The time zone setting can
  // arrive or change after the fields were filled (settings sync): the text
  // is read in the zone it was written in, then rewritten for the new zone.
  const [inputZone, setInputZone] = useState(timeZone);
  // A field the browser holds half filled in (a date without its time) reads
  // as empty, without an event when it was empty before: told apart here, so
  // it does not pass for "no date", which leaves that end of the period open.
  const [halfFilled, setHalfFilled] = useState({ from: false, to: false });
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const localFromDate = fieldMoment(fromInput, fromDate, inputZone);
  const localToDate = fieldMoment(toInput, toDate, inputZone);
  useEffect(() => {
    if (timeZone === inputZone) return;
    // The same moments, shown on the new zone's clock; nothing is saved for it.
    if (localFromDate) setFromInput(utcToLocalDatetime(localFromDate, timeZone));
    if (localToDate) setToInput(utcToLocalDatetime(localToDate, timeZone));
    setInputZone(timeZone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeZone]);
  const datesUnusable = localFromDate === null || localToDate === null || halfFilled.from || halfFilled.to;
  const [localSubject, setLocalSubject] = useState(subject);
  // One message editor with formatting. What it holds is HTML; the plain-text
  // part a save sends is derived from it. Until the message is edited (or
  // filled with the starting text) a save sends the stored parts unchanged.
  const [localBody, setLocalBody] = useState(() => htmlBody || textToParagraphHtml(textBody));
  const [bodyEdited, setBodyEdited] = useState(false);
  // The user tried to switch the reply on with no message, or forwarding on
  // with no address: said under the field until it is filled in.
  const [needMessage, setNeedMessage] = useState(false);
  const [needAddress, setNeedAddress] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [forwardEnabled, setForwardEnabled] = useState(forward?.enabled ?? false);
  const [forwardTo, setForwardTo] = useState(forward?.to ?? '');
  const [forwardKeep, setForwardKeep] = useState(forward?.keepCopy ?? false);
  const [audienceOnly, setAudienceOnly] = useState<'all' | 'internal' | 'external'>(audience?.only ?? 'all');
  // "Internal" are the account's own domains, as its identities give them.
  const identities = useIdentityStore((s) => s.identities);
  const domains = useMemo(() => ownDomains(identities.map((i) => i.email)), [identities]);

  // The organisation's reply texts (Organisation > Templates), filled in for
  // the account this page is for: a managed account's own address, never the
  // signed-in user's name.
  const vacationLibrary = usePolicyStore((s) => s.policy.organisation?.vacationTemplates?.library);
  const managedAccount = useManagedAccountStore((s) => s.managedAccount);
  const username = useAuthStore((s) => s.username);
  const templateSender = useMemo(() => {
    if (managedAccountId) {
      const address = managedAccount?.name?.includes('@') ? managedAccount.name : '';
      return { name: '', email: address };
    }
    const own = identities.find((i) => i.email?.toLowerCase() === username?.toLowerCase()) ?? identities[0];
    return { name: own?.name ?? '', email: own?.email ?? username ?? '' };
  }, [managedAccountId, managedAccount, identities, username]);

  useEffect(() => {
    if (client && isSupported) {
      void fetchVacationResponse(client, managedAccountId ?? undefined);
    }
  }, [client, isSupported, managedAccountId, fetchVacationResponse]);

  // The fields take what the server has when it loads and on an account
  // switch. What comes back from a save made here is what was sent: the
  // fields keep what was typed while it ran. Only what the user changed is
  // saved, never a render that hasn't caught up with a load yet.
  const touched = useRef(false);
  const lastSent = useRef<{ reply: string; forward: boolean } | null>(null);
  const syncedAccount = useRef<string | null>(null);
  const storedReply = JSON.stringify([isEnabled, fromDate, toDate, subject, textBody, htmlBody]);
  useEffect(() => {
    if (isLoading) return;
    const newAccount = syncedAccount.current !== accountKey;
    syncedAccount.current = accountKey;
    const sent = newAccount ? null : lastSent.current;
    if (newAccount) lastSent.current = null;
    const stored = useVacationStore.getState();
    if (!sent || sent.reply !== storedReply) {
      touched.current = false;
      setLocalEnabled(stored.isEnabled);
      setFromInput(stored.fromDate ? utcToLocalDatetime(stored.fromDate, timeZone) : '');
      setToInput(stored.toDate ? utcToLocalDatetime(stored.toDate, timeZone) : '');
      setInputZone(timeZone);
      setHalfFilled({ from: false, to: false });
      setNeedMessage(false);
      if (isBlankReply(stored)) {
        // Nothing written yet: start with real text in the user's language,
        // which they can change, so switching on never sends a blank reply.
        // Saved with the first change the user makes, not by opening the page.
        setLocalSubject(tx('default_subject'));
        setLocalBody(textToParagraphHtml(tx('default_message')));
        setBodyEdited(true);
      } else {
        setLocalSubject(stored.subject);
        setLocalBody(stored.htmlBody || textToParagraphHtml(stored.textBody));
        setBodyEdited(false);
      }
    }
    // Forwarding a save didn't send takes what the server has now; one it
    // sent stays as set here, also when its filters part failed and it
    // waits to be saved again.
    if (!sent || sent.reply !== storedReply || !sent.forward) {
      setForwardEnabled(stored.forward?.enabled ?? false);
      setForwardTo(stored.forward?.to ?? '');
      setForwardKeep(stored.forward?.keepCopy ?? false);
      setNeedAddress(false);
    }
    setAudienceOnly(stored.audience?.only ?? 'all');
    // The time zone is read when the fields load, not followed while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, isLoading, storedReply, forward, audience]);

  // How long the next save waits, set by the control that changed.
  const saveDelay = useRef(SAVE_AT_ONCE);
  const changeNow = <T,>(set: (value: T) => void) => (value: T) => {
    touched.current = true;
    saveDelay.current = SAVE_AT_ONCE;
    set(value);
  };
  const changeTyped = <T,>(set: (value: T) => void) => (value: T) => {
    touched.current = true;
    saveDelay.current = SAVE_AFTER_TYPING;
    set(value);
  };

  const applyTemplate = (filled: FilledVacationTemplate) => {
    touched.current = true;
    saveDelay.current = SAVE_AFTER_TYPING;
    if (filled.subject) setLocalSubject(filled.subject);
    setLocalBody(filled.html || textToParagraphHtml(filled.text));
    setBodyEdited(true);
  };

  const editBody = (html: string) => {
    touched.current = true;
    saveDelay.current = SAVE_AFTER_TYPING;
    setLocalBody(html);
    setBodyEdited(true);
  };

  // Reads a date field as the browser holds it, half filled in or not.
  const readDateField = (field: 'from' | 'to', input: HTMLInputElement) => {
    touched.current = true;
    saveDelay.current = SAVE_AFTER_TYPING;
    (field === 'from' ? setFromInput : setToInput)(input.value);
    const half = input.validity.badInput;
    setHalfFilled((current) => (current[field] === half ? current : { ...current, [field]: half }));
  };

  // Who gets the auto-reply as a save stores it: everyone, or the senders
  // from (or not from) the account's domains as they are now. The domains
  // come from the signed-in user's identities, so a managed (shared) account
  // offers no narrowing rather than one built from the wrong domains.
  const canNarrow = audienceAvailable && !managedAccountId && domains.length > 0;
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
  // The address field shows while forwarding is off too, so typing one
  // there before switching on is not a change of its own.
  const forwardSettings = !forwardAvailable
    ? undefined
    : forwardEnabled || (forward && isValidEmail(forwardTo))
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

  // What a save sends: the sanitized HTML and the plain-text part derived
  // from it (for mail apps without HTML). A message nobody edited goes as
  // the server has it, so switching the reply on rewrites nothing.
  const payload = useMemo(() => {
    if (!bodyEdited) return { sanitizedHtml: htmlBody || null, textBody };
    const sanitizedHtml = hasReadableText(localBody) ? sanitizeEmailHtml(localBody) : null;
    return { sanitizedHtml, textBody: sanitizedHtml ? textFromHtml(sanitizedHtml) : '' };
  }, [bodyEdited, localBody, htmlBody, textBody]);
  const bodyEmpty = !payload.textBody.trim() && !hasReadableText(payload.sanitizedHtml);

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

  // Checked as you type, under the field they are about.
  const endBeforeStart = !!(localFromDate && localToDate && new Date(localToDate) <= new Date(localFromDate));
  const fromError = localFromDate === null || halfFilled.from ? t('warnings.invalid_date') : null;
  const toError = localToDate === null || halfFilled.to
    ? t('warnings.invalid_date')
    : endBeforeStart ? t('warnings.end_before_start') : null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Only a start the user just set: a stored one passes while they are away.
  const fromWarning = !fromError && localFromDate && localFromDate !== fromDate && new Date(localFromDate) < todayStart
    ? t('warnings.start_in_past')
    : null;
  // An empty message never goes live: the switch won't turn on, and a reply
  // that is on can't be saved with its text deleted.
  const bodyError = oversize.body && sizeLimits
    ? t('warnings.body_too_long', { max: sizeLimits.body })
    : (localEnabled || needMessage) && bodyEmpty ? tx('write_message_first') : null;

  // The bodies are compared as a save sends them: the server keeps the
  // sanitized HTML and the text derived from it, never what was typed.
  const userChanges =
    localEnabled !== isEnabled ||
    (localFromDate || null) !== (fromDate || null) ||
    (localToDate || null) !== (toDate || null) ||
    localSubject !== subject ||
    payload.textBody !== textBody ||
    (payload.sanitizedHtml ?? '') !== (htmlBody || '') ||
    forwardChanged ||
    audienceChanged;

  const hasBlockingError =
    datesUnusable ||
    !!(localFromDate && localToDate && new Date(localToDate) <= new Date(localFromDate)) ||
    oversize.subject || oversize.body || forwardInvalid || (localEnabled && bodyEmpty);

  const switchReply = (on: boolean) => {
    if (on && bodyEmpty) {
      setNeedMessage(true);
      return;
    }
    setNeedMessage(false);
    changeNow(setLocalEnabled)(on);
  };
  const switchForward = (on: boolean) => {
    if (on && !isValidEmail(forwardTo)) {
      setNeedAddress(true);
      return;
    }
    setNeedAddress(false);
    changeNow(setForwardEnabled)(on);
  };

  // What a save would store, to tell one change from the next.
  const snapshot = JSON.stringify([
    localEnabled, localFromDate, localToDate, localSubject, payload, forwardSettings, audienceSettings,
  ]);
  // A save that failed or was stopped isn't tried again until something changes.
  const [refusedSnapshot, setRefusedSnapshot] = useState<string | null>(null);
  // The same, at once: a timer set while the failed save's last render was
  // on its way must not send it again.
  const refusedRef = useRef<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const savingSnapshot = useRef<string | null>(null);

  const handleSave = async () => {
    if (!client) return;
    // Half filled in without a single event: only the field itself knows.
    const half = { from: !!fromRef.current?.validity.badInput, to: !!toRef.current?.validity.badInput };
    if (half.from || half.to) {
      setHalfFilled(half);
      return;
    }
    if (hasBlockingError) return;

    const { sanitizedHtml, textBody } = payload;
    const sent = snapshot;
    savingSnapshot.current = sent;
    lastSent.current = {
      reply: JSON.stringify([
        localEnabled, localFromDate || null, localToDate || null, localSubject, textBody, sanitizedHtml,
      ]),
      forward: forwardChanged,
    };

    try {
      const saved = await updateVacationResponse(client, {
        isEnabled: localEnabled,
        fromDate: localFromDate || null,
        toDate: localToDate || null,
        subject: localSubject,
        textBody,
        htmlBody: sanitizedHtml,
        forward: forwardChanged ? forwardSettings : undefined,
        audience: audienceChanged ? audienceSettings : undefined,
      }, managedAccountId ?? undefined);

      // false: a plugin stopped the change and is expected to have said why.
      if (saved) setSavedOnce(true);
      else {
        refusedRef.current = sent;
        setRefusedSnapshot(sent);
      }
    } catch (error) {
      console.error('Failed to save vacation response:', error);
      refusedRef.current = sent;
      setRefusedSnapshot(sent);
      toast.error(tNotifications(
        error instanceof VacationFiltersError ? 'vacation_filters_save_failed' : 'vacation_save_failed',
      ));
    } finally {
      savingSnapshot.current = null;
    }
  };

  // The latest save, and whether one is waiting, for the timer and for
  // leaving the page.
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const canAutoSave = !!client && userChanges && !hasBlockingError && snapshot !== refusedSnapshot;
  const waitingRef = useRef(false);
  waitingRef.current = canAutoSave && savingSnapshot.current !== snapshot;

  // Leaving the page (another settings page, another app) saves what is
  // still waiting for its timer.
  useEffect(() => () => {
    if (waitingRef.current && touched.current) void saveRef.current();
  }, []);

  useEffect(() => {
    if (!canAutoSave || isSaving || !touched.current) return;
    const due = snapshot;
    const timer = setTimeout(() => {
      if (refusedRef.current !== due) void saveRef.current();
    }, saveDelay.current);
    return () => clearTimeout(timer);
  }, [canAutoSave, isSaving, snapshot]);

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
      <div role="status" aria-live="polite" className="flex justify-end items-center gap-1.5 min-h-4 -mb-4 text-xs text-muted-foreground">
        {isSaving ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('saving')}</>
        ) : savedOnce && !userChanges ? (
          <><Check className="w-3.5 h-3.5" />{t('saved')}</>
        ) : null}
      </div>
      {notRunning && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 min-w-0">{t('warnings.not_running')}</span>
          <Button size="xs" variant="outline" onClick={() => void handleSave()} disabled={isSaving || hasBlockingError}>
            {t('save')}
          </Button>
        </div>
      )}
      {/* The switch first, then who gets it and when; the period applies to forwarding too. */}
      <SettingsSection id="reply" title={t('title')} description={t('status.description')}>
        <SettingItem label={t('status.label')}>
          <StatusSwitch
            checked={localEnabled}
            onChange={switchReply}
            activeLabel={t('status.active')}
            inactiveLabel={t('status.inactive')}
          />
        </SettingItem>
        {!localEnabled && <VacationFilterWarning accountId={managedAccountId ?? undefined} />}
        {canNarrow && (
          <SettingItem label={t('audience.label')}>
            <Select
              value={audienceOnly}
              onChange={(value) => changeNow(setAudienceOnly)(value as 'all' | 'internal' | 'external')}
              options={[
                { value: 'all', label: tx('audience_all') },
                { value: 'internal', label: tx('audience_internal', { domains: domains.join(', ') }) },
                { value: 'external', label: tx('audience_external') },
              ]}
            />
          </SettingItem>
        )}
        <SettingItem
          label={tx('from_label')}
          description={tx('from_description')}
        >
          <input
            ref={fromRef}
            type="datetime-local"
            max={DATE_INPUT_MAX}
            value={fromInput}
            onChange={(e) => readDateField('from', e.currentTarget)}
            onBlur={(e) => readDateField('from', e.currentTarget)}
            aria-label={tx('from_label')}
            aria-invalid={!!fromError}
            aria-describedby={fromError ? 'vacation-from-error' : undefined}
            className={cn(DATE_FIELD, fromError && 'border-destructive hover:border-destructive')}
          />
        </SettingItem>
        <FieldMessage id="vacation-from-error" text={fromError} />
        <FieldMessage text={fromWarning} warning />
        <SettingItem
          label={tx('until_label')}
          description={tx('until_description')}
        >
          <input
            ref={toRef}
            type="datetime-local"
            max={DATE_INPUT_MAX}
            value={toInput}
            onChange={(e) => readDateField('to', e.currentTarget)}
            onBlur={(e) => readDateField('to', e.currentTarget)}
            aria-label={tx('until_label')}
            aria-invalid={!!toError}
            aria-describedby={toError ? 'vacation-to-error' : undefined}
            className={cn(DATE_FIELD, toError && 'border-destructive hover:border-destructive')}
          />
        </SettingItem>
        <FieldMessage id="vacation-to-error" text={toError} />
        <VacationCalendarBlock hasDates={!!fromInput && !!toInput} accountId={managedAccountId ?? undefined} />
      </SettingsSection>

      <VacationTemplatePicker
        library={vacationLibrary ?? []}
        base={{
          name: templateSender.name,
          email: templateSender.email,
          company: companyName(),
          fromDate: localFromDate || null,
          toDate: localToDate || null,
          locale,
          timeZone,
        }}
        onApply={applyTemplate}
      />

      <SettingsSection id="reply-message" title={tx('message_title')}>
        <SettingItem
          label={t('message.subject_label')}
          description={t('message.subject_description')}
        >
          <input
            type="text"
            value={localSubject}
            onChange={(e) => changeTyped(setLocalSubject)(e.target.value)}
            placeholder={t('message.subject_placeholder')}
            aria-label={t('message.subject_label')}
            aria-invalid={oversize.subject}
            className="w-64 max-w-full px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground placeholder:text-muted-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground"
          />
        </SettingItem>
        <FieldMessage text={oversize.subject && sizeLimits ? t('warnings.subject_too_long', { max: sizeLimits.subject }) : null} />
        <div className="py-3" data-search-label={tx('message_label')}>
          <span id="vacation-body-label" className="text-sm font-medium text-foreground block mb-1">
            {tx('message_label')}
          </span>
          <p className="text-xs text-muted-foreground mb-2">
            {tx('message_description')}
          </p>
          <div className={cn('rounded-md border overflow-hidden', bodyError ? 'border-destructive' : 'border-border')}>
            <RichTextEditor
              content={localBody}
              onChange={editBody}
              ariaLabel={tx('message_label')}
              ariaInvalid={!!bodyError}
              ariaDescribedBy={bodyError ? 'vacation-body-error' : undefined}
            />
          </div>
          <FieldMessage id="vacation-body-error" text={bodyError} />
        </div>
      </SettingsSection>

      {(() => {
        const showHtmlPreview = hasReadableText(payload.sanitizedHtml);
        if (bodyEmpty) return null;
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
                    dangerouslySetInnerHTML={{ __html: payload.sanitizedHtml ?? '' }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payload.textBody}</p>
                )}
              </div>
            )}
          </SettingsSection>
        );
      })()}

      {forwardAvailable && (
        <SettingsSection id="forward" title={t('forward.title')} description={t('forward.description')}>
          <SettingItem label={t('forward.enabled_label')}>
            <StatusSwitch
              checked={forwardEnabled}
              onChange={switchForward}
              activeLabel={t('status.active')}
              inactiveLabel={t('status.inactive')}
            />
          </SettingItem>
          {/* The address shows while forwarding is off, so it can be filled in before switching on. */}
          <SettingItem label={t('forward.to_label')}>
            <input
              type="email"
              value={forwardTo}
              onChange={(e) => changeTyped(setForwardTo)(e.target.value)}
              placeholder={t('forward.to_placeholder')}
              aria-label={t('forward.to_label')}
              aria-invalid={forwardInvalid || (needAddress && !isValidEmail(forwardTo))}
              className="w-64 max-w-full px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground placeholder:text-muted-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground"
            />
          </SettingItem>
          <FieldMessage
            text={forwardInvalid
              ? t('warnings.forward_address')
              : needAddress && !isValidEmail(forwardTo) ? tx('enter_address_first') : null}
          />
          {forwardEnabled && (
            <>
              <SettingItem label={t('forward.keep_label')} description={t('forward.keep_description')}>
                <ToggleSwitch checked={forwardKeep} onChange={changeNow(setForwardKeep)} />
              </SettingItem>
              <FieldMessage text={forwardOverLimit ? tFilters('forward_limit', { count: forwardLimit }) : null} warning />
            </>
          )}
        </SettingsSection>
      )}

    </div>
  );
}

/** A line under a field: an error that stops the save, or a warning. */
function FieldMessage({ id, text, warning = false }: { id?: string; text: string | null; warning?: boolean }) {
  if (!text) return null;
  return (
    <p
      id={id}
      className={cn(
        'flex items-start gap-1.5 -mt-1 pb-2 text-xs',
        warning ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400',
      )}
    >
      <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
      <span>{text}</span>
    </p>
  );
}
