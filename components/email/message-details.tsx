"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { ContactCard, Email } from "@/lib/jmap/types";
import type { EmailReadView } from "@/lib/plugin-types";
import { cn, formatDateTime, formatFileSize } from "@/lib/utils";
import { getSecurityStatus, getSenderVerification, isImportedMessage, type extractListHeaders } from "@/lib/email-headers";
import { AlertTriangle, Brain, Check, ChevronDown, ChevronUp, Minus, Shield, ShieldAlert, X } from "@/components/icons";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { BreakableAddress } from "@/components/ui/breakable-address";
import { BrandVerifiedBadge } from "@/components/email/brand-verified-badge";
import { ExternalSenderChip } from "./external-sender-chip";
import { ReceivedLabelChip } from "./received-label-chip";
import { RecipientPopover } from "./recipient-popover";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type ViewContact = (contact: ContactCard | null, email: string) => void;

// Helper to render clickable recipient elements with popovers
export function renderClickableRecipients(
  recipients: Array<{ name?: string; email: string }>,
  currentUserEmail: string | undefined,
  t: Translate,
  onViewContact?: ViewContact,
  maxVisible: number = 2
) {
  const visible = recipients.slice(0, maxVisible);
  return visible.map((r, index) => {
    const isMe = currentUserEmail &&
      (r.email.toLowerCase() === currentUserEmail.toLowerCase() ||
       r.email.toLowerCase().startsWith(currentUserEmail.toLowerCase().split('@')[0] + '+'));

    return (
      <span key={r.email + index} className="inline-flex items-center">
        <RecipientPopover
          name={r.name}
          email={r.email}
          displayLabel={isMe ? t('recipient_me') : undefined}
          onViewContact={onViewContact}
          className="text-sm"
        />
        {index < visible.length - 1 && <span className="text-muted-foreground">,</span>}
      </span>
    );
  });
}

/**
 * The sender check of a message (see getSenderVerification) with its label
 * and sentence. Nothing for a message from an imported file, which the
 * user's server never checked (#1740).
 */
export function senderCheckText(email: Email, t: Translate) {
  const verification = isImportedMessage(email) ? null : getSenderVerification(email.authenticationResults, email.from?.[0]?.email);
  const label = verification?.status === 'failed'
    ? t('sender_check.failed_label')
    : t('sender_check.unverified_label');
  const message = !verification
    ? ''
    : verification.status === 'failed'
      ? verification.sentFrom
        ? t('sender_check.failed_sent_from', { domain: verification.domain, host: verification.sentFrom })
        : t('sender_check.failed', { domain: verification.domain })
      : verification.sentFrom
        ? t('sender_check.unverified_sent_from', { domain: verification.domain, host: verification.sentFrom })
        : t('sender_check.unverified', { domain: verification.domain });
  return { verification, label, message };
}

/**
 * The line under a message's sender: its To, CC and BCC recipients and the
 * "Show details" switch. The open message and every unfolded message of a
 * conversation show the same line (#1743). The phone layout points at the
 * recipients with an arrow and leaves BCC to the details.
 */
export function MessageRecipientsLine({
  email,
  currentUserEmail,
  onViewContact,
  expanded,
  onToggle,
  phone,
  className,
}: {
  email: Email;
  currentUserEmail?: string;
  onViewContact?: ViewContact;
  expanded: boolean;
  onToggle: () => void;
  phone?: boolean;
  className?: string;
}) {
  const t = useTranslations('email_viewer');
  return (
    <div className={cn("flex items-center text-sm text-muted-foreground flex-wrap", phone ? "mt-0.5 gap-1" : "mt-1 gap-2", className)} data-message-recipients="">
      {email.to && email.to.length > 0 && (
        <>
          <span>{phone ? `→ ${t('recipient_to_prefix')}` : t('recipient_to_prefix')}</span>
          {renderClickableRecipients(email.to, currentUserEmail, t, onViewContact)}
          {email.to.length > 2 && (
            <button
              type="button"
              onClick={onToggle}
              className="text-primary hover:underline text-sm"
            >
              {t('more_count', { count: email.to.length - 2 })}
            </button>
          )}
        </>
      )}
      {email.cc && email.cc.length > 0 && (
        <>
          <span className="text-muted-foreground">|</span>
          <span>{t('cc')}:</span>
          {renderClickableRecipients(email.cc, currentUserEmail, t, onViewContact)}
          {email.cc.length > 2 && (
            <button
              type="button"
              onClick={onToggle}
              className="text-primary hover:underline text-sm"
            >
              {t('more_count', { count: email.cc.length - 2 })}
            </button>
          )}
        </>
      )}
      {!phone && email.bcc && email.bcc.length > 0 && (
        <>
          <span className="text-muted-foreground">|</span>
          <span>{t('bcc')}:</span>
          {renderClickableRecipients(email.bcc, currentUserEmail, t, onViewContact)}
          {email.bcc.length > 2 && (
            <span className="text-muted-foreground">+{email.bcc.length - 2}</span>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-message-details-toggle=""
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors ms-1 whitespace-nowrap"
      >
        {expanded ? (
          <>
            <ChevronUp className="w-3 h-3" />
            {t('hide_details')}
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" />
            {t('show_details')}
          </>
        )}
      </button>
    </div>
  );
}

/**
 * The plugin slot under one "more details" category. Props are memoised so
 * re-renders of the viewer don't post them to the plugin again.
 */
export function DetailsCategorySlot({ email, category }: { email: EmailReadView | null; category: string | null }) {
  const props = useMemo(() => ({ email, category }), [email, category]);
  return <PluginSlot name="email-details-section" className="mt-2 empty:mt-0" extraProps={props} />;
}

/**
 * A message's details: sender and recipients, the server's checks
 * (SPF, DKIM, DMARC, spam score), ids, size and mailing list. The open
 * message and every unfolded message of a conversation show this same
 * panel (#1744).
 */
export function MessageDetailsPanel({
  email,
  timeFormat,
  currentUserEmail,
  onViewContact,
  brandDomain,
  attachments,
  listHeaders,
  pluginEmailView,
  hasPluginSection,
  className,
}: {
  email: Email;
  timeFormat: '12h' | '24h';
  currentUserEmail?: string;
  onViewContact?: ViewContact;
  brandDomain?: string;
  /** The attachments the message shows, for their count and size. */
  attachments: readonly { size?: number }[];
  listHeaders: ReturnType<typeof extractListHeaders> | null;
  pluginEmailView: EmailReadView | null;
  /** Whether a plugin offers a section of its own under the categories. */
  hasPluginSection: boolean;
  /** Replaces the side padding. */
  className?: string;
}) {
  const t = useTranslations('email_viewer');
  const sender = email.from?.[0];
  const { verification: senderVerification, label: senderVerificationLabel, message: senderVerificationMessage } = senderCheckText(email, t);
  const translateAuthResult = (result?: string) => {
    const r = (result || '').toLowerCase();
    switch (r) {
      case 'pass': return t('authentication.result.pass');
      case 'fail': return t('authentication.result.fail');
      case 'softfail': return t('authentication.result.softfail');
      case 'neutral': return t('authentication.result.neutral');
      case 'permerror': return t('authentication.result.permerror');
      case 'temperror': return t('authentication.result.temperror');
      case 'none': return t('authentication.result.none');
      default: return result || '';
    }
  };
  const replyToDifferent = !!email.replyTo?.length &&
    (!email.from || email.replyTo[0].email !== email.from[0]?.email);
  // Received before it was sent means a wrong clock somewhere, not a
  // delivery time (mail-29).
  const deliveryDeltaMs = email.sentAt && email.receivedAt
    ? new Date(email.receivedAt).getTime() - new Date(email.sentAt).getTime()
    : 0;
  const formatDelta = (diff: number) => {
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const dayUnit = days > 1 ? t('time.days') : t('time.day');
    const hourUnit = (hours % 24) > 1 ? t('time.hours') : t('time.hour');
    const minuteUnit = (minutes % 60) > 1 ? t('time.minutes') : t('time.minute');
    const minuteUnitSingle = minutes > 1 ? t('time.minutes') : t('time.minute');
    if (days > 0) return `${days} ${dayUnit} ${hours % 24} ${hourUnit}`;
    if (hours > 0) return `${hours} ${hourUnit} ${minutes % 60} ${minuteUnit}`;
    return `${minutes} ${minuteUnitSingle}`;
  };
  const fullDate = (iso?: string) => iso
    ? formatDateTime(iso, timeFormat, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', second: '2-digit', timeZoneName: 'short' })
    : '-';
  // A long date wraps over three lines in the narrow column: the short one
  // shows, the full one is on hover.
  const shownDate = (iso?: string) => iso
    ? <time dateTime={iso} title={fullDate(iso)}>{formatDateTime(iso, timeFormat, { year: 'numeric', month: 'short', day: 'numeric' })}</time>
    : '-';
  // Only the receiving server's results, never an imported file's (#1740).
  const auth = isImportedMessage(email) ? undefined : email.authenticationResults;
  const totalAttachmentSize = attachments.reduce((s, a) => s + (a.size || 0), 0);
  const topMimeType = email.bodyStructure?.type;
  const SectionHeader = ({ children }: { children: React.ReactNode }) => (
    <div className="text-[0.6875rem] font-semibold text-muted-foreground mb-1.5">
      {children}
    </div>
  );
  const Row = ({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) => (
    <>
      <dt className="text-muted-foreground text-xs @sm:pt-1">{label}</dt>
      <dd className={cn(
        "text-sm text-foreground min-w-0 break-words",
        mono && "font-mono text-xs",
      )}>{children}</dd>
    </>
  );
  const AuthChip = ({ name, result, extra, tooltip }: { name: string; result?: string; extra?: React.ReactNode; tooltip?: string }) => {
    if (!result) return null;
    const status = getSecurityStatus(result);
    const Icon = status.icon === 'check' ? Check
      : status.icon === 'x' ? X
      : status.icon === 'alert' ? AlertTriangle
      : Minus;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs max-w-full min-w-0",
          tooltip && "cursor-help",
          status.icon === 'check' && "bg-green-500/[0.07] border-green-500/30",
          status.icon === 'x' && "bg-red-500/[0.07] border-red-500/30",
          status.icon === 'alert' && "bg-amber-500/[0.07] border-amber-500/30",
          status.icon === 'minus' && "bg-muted/40 border-border",
        )}
        title={tooltip}
      >
        <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", status.color)} />
        <span className="font-medium text-foreground whitespace-nowrap">{name}</span>
        <span className={cn("text-[0.6875rem] whitespace-nowrap", status.color)}>
          {translateAuthResult(result)}
        </span>
        {extra && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground truncate min-w-0" title={typeof extra === 'string' ? extra : undefined}>{extra}</span>
          </>
        )}
      </span>
    );
  };

  const hasIdentifiers = !!(email.messageId || email.inReplyTo?.length || email.references?.length || email.threadId);
  const hasListInfo = !!(listHeaders?.listId || listHeaders?.listUnsubscribe || listHeaders?.listHelp || listHeaders?.listPost);
  const hasAuthSection = !!(auth?.spf || auth?.dkim || auth?.dmarc || auth?.iprev || email.spamScore !== undefined || email.spamLLM);

  // Lets a plugin add rows under an existing category. The plugin's
  // own `shouldShow({ email, category })` decides which category it
  // appears under (or `category === null` for the new bottom section).
  const categorySlot = (category: string) => (
    <DetailsCategorySlot email={pluginEmailView} category={category} />
  );

  return (
    <div className={cn("@container bg-background border-b border-border", className ?? "px-4 lg:px-6")} style={{ paddingBlock: 'var(--density-header-py)' }} data-message-details="">
      <div className="grid grid-cols-1 @3xl:grid-cols-2 gap-x-10 gap-y-5">
        <section className="min-w-0">
          <SectionHeader>{t('details.recipients_routing')}</SectionHeader>
          <dl data-plugin-list-avoid="" className="grid grid-cols-1 @sm:grid-cols-[minmax(4.5rem,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Row label={t('from')}>
              {/* The name and the address are lines of their own, so
                  the check mark and chips follow the name, not the
                  longer address under it. */}
              <div className="flex flex-wrap items-center gap-1" data-details-from-name="">
                <RecipientPopover
                  name={sender?.name}
                  email={sender?.email || ''}
                  onViewContact={onViewContact}
                  className="text-sm text-start"
                />
                <BrandVerifiedBadge domain={brandDomain} />
                <ExternalSenderChip from={email.from} accountId={email.sourceClientAccountId} />
                <ReceivedLabelChip email={email} />
                {senderVerification && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-xs whitespace-nowrap cursor-help",
                      senderVerification.status === 'failed'
                        ? "bg-red-500/[0.07] border-red-500/30 text-red-700 dark:text-red-400"
                        : "bg-amber-500/[0.07] border-amber-500/30 text-amber-700 dark:text-amber-400",
                    )}
                    title={senderVerificationMessage}
                  >
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    {senderVerificationLabel}
                  </span>
                )}
              </div>
              {sender?.name && sender?.email && (
                <RecipientPopover
                  name={sender.name}
                  email={sender.email}
                  label={(
                    <bdi className="block text-muted-foreground" title={sender.email}>
                      <BreakableAddress text={sender.email} />
                    </bdi>
                  )}
                  onViewContact={onViewContact}
                  className="block text-sm text-start"
                />
              )}
            </Row>
            {replyToDifferent && (
              <Row label={t('reply_to_label').replace(':', '')}>
                <div className="flex flex-wrap items-center gap-1">
                  {email.replyTo!.map((r, i) => (
                    <RecipientPopover key={r.email + i} name={r.name} email={r.email} onViewContact={onViewContact} className="text-sm" />
                  ))}
                </div>
              </Row>
            )}
            {email.to && email.to.length > 0 && (
              <Row label={t('to')}>
                <div className="flex flex-wrap items-center gap-1">
                  {renderClickableRecipients(email.to, currentUserEmail, t, onViewContact, 100)}
                </div>
              </Row>
            )}
            {email.cc && email.cc.length > 0 && (
              <Row label={t('cc')}>
                <div className="flex flex-wrap items-center gap-1">
                  {renderClickableRecipients(email.cc, currentUserEmail, t, onViewContact, 100)}
                </div>
              </Row>
            )}
            {email.bcc && email.bcc.length > 0 && (
              <Row label={t('bcc')}>
                <div className="flex flex-wrap items-center gap-1">
                  {renderClickableRecipients(email.bcc, currentUserEmail, t, onViewContact, 100)}
                </div>
              </Row>
            )}
            {email.sentAt && (
              <Row label={t('details.sent')}>{shownDate(email.sentAt)}</Row>
            )}
            <Row label={t('details.received')}>
              {shownDate(email.receivedAt)}
              {deliveryDeltaMs > 60000 && (
                <span className="text-muted-foreground"> · {formatDelta(deliveryDeltaMs)} {t('details.delivery_time').toLowerCase()}</span>
              )}
            </Row>
          </dl>
          {categorySlot("recipients_routing")}
        </section>

        {hasAuthSection && (
          <section className="min-w-0">
            <SectionHeader>{t('details.authentication_security')}</SectionHeader>
            <div className="flex flex-wrap gap-1.5" data-plugin-list-avoid="">
              {auth?.spf && (() => {
                // When multiple identities (HELO + MAIL FROM) were
                // evaluated, list each result in the tooltip for full
                // transparency; the chip itself shows the most severe.
                const breakdown = auth.spf.all && auth.spf.all.length > 1
                  ? auth.spf.all
                      .map((r) => {
                        const label = r.identity === 'mailfrom' ? 'MAIL FROM' : r.identity === 'helo' ? 'HELO' : 'SPF';
                        return `${label}: ${translateAuthResult(r.result)}${r.domain ? ` (${r.domain})` : ''}`;
                      })
                      .join('\n')
                  : null;
                return (
                  <AuthChip
                    name="SPF"
                    result={auth.spf.result}
                    extra={auth.spf.domain}
                    tooltip={breakdown ? `${t('authentication.tooltip_spf')}\n\n${breakdown}` : t('authentication.tooltip_spf')}
                  />
                );
              })()}
              {auth?.dkim && (
                <AuthChip name="DKIM" result={auth.dkim.result} extra={auth.dkim.domain} tooltip={t('authentication.tooltip_dkim')} />
              )}
              {auth?.dmarc && (
                <AuthChip name="DMARC" result={auth.dmarc.result} extra={auth.dmarc.policy ? `${t('authentication.policy').toLowerCase()}: ${auth.dmarc.policy}` : undefined} tooltip={t('authentication.tooltip_dmarc')} />
              )}
              {auth?.iprev && (
                <AuthChip name={t('details.iprev')} result={auth.iprev.result} extra={auth.iprev.ip} />
              )}
              {email.spamScore !== undefined && (
                <span className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs max-w-full min-w-0",
                  email.spamScore > 5 ? "bg-red-500/[0.07] border-red-500/30" :
                  email.spamScore > 2 ? "bg-amber-500/[0.07] border-amber-500/30" :
                  "bg-green-500/[0.07] border-green-500/30",
                )}>
                  <Shield className={cn(
                    "w-3.5 h-3.5",
                    email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                    email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                    "text-green-700 dark:text-green-400",
                  )} />
                  <span className="font-medium text-foreground">{t('authentication.spam_score')}</span>
                  <span className={cn(
                    "text-[0.6875rem]",
                    email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                    email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                    "text-green-700 dark:text-green-400",
                  )}>
                    {email.spamScore.toFixed(1)}
                  </span>
                  {email.spamStatus && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground truncate min-w-0" title={email.spamStatus}>{email.spamStatus}</span>
                    </>
                  )}
                </span>
              )}
            </div>
            {email.spamLLM && (
              <div className="mt-2 flex items-start gap-2 text-sm" data-plugin-list-avoid="">
                {email.spamLLM.verdict === 'LEGITIMATE' ? <Brain className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-700 dark:text-green-400" /> :
                 email.spamLLM.verdict === 'SPAM' ? <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-700 dark:text-red-400" /> :
                 <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700 dark:text-amber-400" />}
                <div className="min-w-0">
                  <span className={cn(
                    "font-medium",
                    email.spamLLM.verdict === 'LEGITIMATE' ? "text-green-700 dark:text-green-400" :
                    email.spamLLM.verdict === 'SPAM' ? "text-red-700 dark:text-red-400" :
                    "text-amber-700 dark:text-amber-400",
                  )}>
                    {email.spamLLM.verdict}
                  </span>
                  <span className="text-muted-foreground"> · {email.spamLLM.explanation}</span>
                </div>
              </div>
            )}
            {categorySlot("authentication_security")}
          </section>
        )}

        {hasIdentifiers && (
          <section className="min-w-0">
            <SectionHeader>{t('details.identifiers_threading')}</SectionHeader>
            <dl className="grid grid-cols-1 @sm:grid-cols-[minmax(4.5rem,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              {email.messageId && (
                <Row label={t('headers.message_id')} mono><BreakableAddress text={email.messageId} /></Row>
              )}
              {email.inReplyTo && email.inReplyTo.length > 0 && (
                <Row label={t('details.in_reply_to')} mono>
                  <div className="space-y-0.5">
                    {email.inReplyTo.map((id, i) => <div key={i} className="break-all">{id}</div>)}
                  </div>
                </Row>
              )}
              {email.references && email.references.length > 0 && (
                <Row label={t('details.references')}>
                  <details className="group">
                    <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors list-none flex items-center gap-1">
                      <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                      {t(email.references.length === 1 ? 'previous_messages' : 'previous_messages_plural', { count: email.references.length })}
                    </summary>
                    <div className="mt-1 space-y-0.5 font-mono text-xs">
                      {email.references.map((id, i) => <div key={i} className="break-all">{id}</div>)}
                    </div>
                  </details>
                </Row>
              )}
              {email.threadId && (
                <Row label={t('details.thread_id')} mono>{email.threadId}</Row>
              )}
            </dl>
            {categorySlot("identifiers_threading")}
          </section>
        )}

        <section className="min-w-0">
          <SectionHeader>{t('details.message_properties')}</SectionHeader>
          <dl className="grid grid-cols-1 @sm:grid-cols-[minmax(4.5rem,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {email.subject !== undefined && (
              <Row label={t('subject')}>{email.subject || <span className="italic text-muted-foreground">{t('details.no_subject')}</span>}</Row>
            )}
            <Row label={t('details.size')}>
              <bdi>{formatFileSize(email.size)}</bdi>
              {topMimeType && (
                <span className="text-muted-foreground"> · <span className="font-mono text-xs">{topMimeType}</span></span>
              )}
            </Row>
            {attachments.length > 0 && (
              <Row label={t('attachments')}>
                {t('attachments_count', { count: attachments.length })} · {formatFileSize(totalAttachmentSize)}
              </Row>
            )}
            {email.accountLabel && (
              <Row label={t('details.account')}>{email.accountLabel}</Row>
            )}
          </dl>
          {categorySlot("message_properties")}
        </section>

        {hasListInfo && (
          <section className="@3xl:col-span-2 min-w-0">
            <SectionHeader>{t('details.mailing_list')}</SectionHeader>
            <dl className="grid grid-cols-1 @sm:grid-cols-[minmax(4.5rem,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              {listHeaders?.listId && (
                <Row label={t('details.list_id')} mono>{listHeaders.listId}</Row>
              )}
              {listHeaders?.listUnsubscribe?.preferred && (
                <Row label={t('details.list_unsubscribe')}>
                  <span className="break-all">
                    {listHeaders.listUnsubscribe.preferred === 'http'
                      ? listHeaders.listUnsubscribe.http
                      : listHeaders.listUnsubscribe.mailto}
                  </span>
                </Row>
              )}
              {listHeaders?.listHelp && (
                <Row label={t('details.list_help')}><span className="break-all">{listHeaders.listHelp}</span></Row>
              )}
              {listHeaders?.listPost && (
                <Row label={t('details.list_post')}><span className="break-all">{listHeaders.listPost}</span></Row>
              )}
            </dl>
            {categorySlot("mailing_list")}
          </section>
        )}

        {/* Plugin-supplied category. Plugins whose shouldShow accepts
            `category === null` render their own titled section here. */}
        {hasPluginSection && (
          <section className="@3xl:col-span-2 min-w-0">
            <DetailsCategorySlot email={pluginEmailView} category={null} />
          </section>
        )}
      </div>
    </div>
  );
}
