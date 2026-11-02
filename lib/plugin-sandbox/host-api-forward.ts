// Host side of api.email.forward: a plugin forwards a message of the account,
// with its attachments, without opening the composer. The e-invoice plugin
// uses it to send an invoice to the accounting address in one click.
//
// Sending in the user's name is the risky part, so:
// - the first forward to an address asks the user in a dialog the host
//   draws (naming the plugin, the message and the address); "Allow" is
//   remembered for that plugin, address and account, and Settings > Plugins
//   lists and removes what was allowed;
// - the forward goes through the same pre-send checks and finalisers as a
//   quick reply (external recipients, the organisation's disclaimer) and
//   other plugins' onBeforeEmailSend, and is held for the user's undo delay;
// - the copy lands in Sent and the original is marked $forwarded, as after
//   a forward from the composer;
// - it carries the original's classification label, else the default; when
//   the organisation requires one and there is neither, nothing is sent.

import type { EmailForwardResult, InstalledPlugin, OutgoingEmail } from '../plugin-types';
import type { Attachment, Email } from '../jmap/types';
import { useIdentityStore } from '@/stores/identity-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useLocaleStore } from '@/stores/locale-store';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import { announceSent } from '../plugin-after-send';
import { buildForwardSubject } from '../subject-prefix';
import { finalizeOutgoing, runPreSendChecks } from '../outgoing/send-pipeline';
import { runPluginSendCheck, sendGuardMessageKey } from '../outgoing/plugin-send-check';
import { externalRecipientsFor, inspectAttachments } from '../outgoing/send-check-payload';
import { automaticLabel, classifyOutgoing } from '../outgoing/classification';
import { whenPolicySettled } from '@/stores/policy-store';
import { toast } from '@/stores/toast-store';
// Registers the organisation signature check and the disclaimer.
import '@/lib/org/outgoing';
import { plainTextFromEmail } from '../plugin-projection';
import { getByPath } from '../settings-search';
import { readNamedEmail } from './host-api-mail';
import { messagesFor } from './host-api-app';
import { approvalAccount, forwardApprovals, saveForwardApprovals } from './forward-approvals';
import { addressOf, readAddressList, readId, readObject, readString, sessionClient, withinRate } from './host-api-input';

/** Most recipients of one forward. */
export const MAX_FORWARD_RECIPIENTS = 10;
/** Forwards a plugin may send per minute. */
export const MAX_FORWARDS_PER_MINUTE = 10;
const MAX_NOTE = 64 * 1024;
const MAX_SELECTED_ATTACHMENTS = 50;

// ─── Text in the user's language ──────────────────────────────

type Messages = Record<string, unknown>;

async function hostMessages(): Promise<Messages> {
  return messagesFor(useLocaleStore.getState().locale || detectBrowserLocale('en'));
}

function text(messages: Messages, path: string, vars: Record<string, string> = {}): string {
  const value = getByPath(messages, path);
  const template = typeof value === 'string' ? value : path;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

// ─── The forward ──────────────────────────────────────────────

export interface ForwardDeps {
  /** Shows a confirm the host draws for the plugin; resolves to the user's answer. */
  confirm: (input: { title: string; message: string; confirmLabel: string; cancelLabel: string }) => Promise<boolean>;
  /** Sets keywords on the original the way api.email.updateKeywords does. */
  markForwarded: (emailId: string, accountId: string | undefined) => Promise<unknown>;
}

function formatAddress(entry: { name?: string | null; email?: string | null } | undefined): string {
  if (!entry?.email) return '';
  return entry.name ? `${entry.name} <${entry.email}>` : entry.email;
}

function attachmentsOf(email: Email): Attachment[] {
  return (email.attachments ?? []).filter((a) => !!a.blobId);
}

/** An inline image of the body, which a forward of the text leaves out. */
function isInline(part: Attachment): boolean {
  return part.disposition === 'inline' && !!part.cid;
}

function pickAttachments(email: Email, selection: unknown, method: string): Attachment[] {
  const all = attachmentsOf(email);
  if (selection === undefined) return all.filter((a) => !isInline(a));
  if (!Array.isArray(selection)) throw new Error(`${method}: attachments must be an array of blobIds`);
  if (selection.length > MAX_SELECTED_ATTACHMENTS) throw new Error(`${method}: at most ${MAX_SELECTED_ATTACHMENTS} attachments`);
  return [...new Set(selection.map((id, i) => readId(id, method, `attachments[${i}]`)))].map((blobId) => {
    const part = all.find((a) => a.blobId === blobId);
    if (!part) throw new Error(`${method}: ${blobId} is not an attachment of this message`);
    return part;
  });
}

/** The forwarded message as text: the note, the original's header lines and its text. */
export function forwardBody(email: Email, note: string, messages: Messages, locale: string): string {
  const label = (key: string) => text(messages, `quote_header.${key}`);
  const date = email.receivedAt ? new Date(email.receivedAt) : null;
  const lines = [
    label('forwarded_separator'),
    `${label('from_label')}: ${(email.from ?? []).map(formatAddress).join(', ')}`,
    `${label('date_label')}: ${date && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale) : ''}`,
    `${label('subject_label')}: ${email.subject ?? ''}`,
  ];
  const to = (email.to ?? []).map(formatAddress).filter(Boolean).join(', ');
  if (to) lines.push(`${text(messages, 'email_viewer.to')}: ${to}`);
  const head = note.trim() ? `${note.trim()}\n\n` : '';
  return `${head}${lines.join('\n')}\n\n${plainTextFromEmail(email)}`;
}

/**
 * Forward `emailId` to `input.to` with the original's attachments. Resolves
 * to what happened; throws on bad input, a missing message or a failed send.
 */
export async function doEmailForward(
  plugin: InstalledPlugin,
  emailIdArg: unknown,
  inputArg: unknown,
  deps: ForwardDeps,
): Promise<EmailForwardResult> {
  const method = 'email.forward';
  const emailId = readId(emailIdArg, method, 'emailId');
  const input = readObject(inputArg, method, 'forward', ['to', 'text', 'attachments', 'accountId']);
  const to = readAddressList(input.to, method, 'to', MAX_FORWARD_RECIPIENTS);
  if (to.length === 0) throw new Error(`${method}: to must name at least one address`);
  const note = input.text === undefined ? '' : readString(input.text, method, 'text', MAX_NOTE);
  if (!withinRate(method, plugin.id, MAX_FORWARDS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${MAX_FORWARDS_PER_MINUTE} forwards a minute`);
  }

  const client = sessionClient(method);
  const found = await readNamedEmail(client, emailId, method, input.accountId);
  if (!found) throw new Error(`${method}: no message with id "${emailId}"`);
  const { email, accountId: sourceAccountId } = found;
  const attachments = pickAttachments(email, input.attachments, method);

  const { identities, preferredPrimaryId } = useIdentityStore.getState();
  const identity = identities.find((i) => i.id === preferredPrimaryId) ?? identities[0];
  if (!identity) throw new Error(`${method}: the account has no sender address to forward from`);

  const locale = useLocaleStore.getState().locale || detectBrowserLocale('en');
  const messages = await hostMessages();
  const subject = buildForwardSubject(email.subject || text(messages, 'email_viewer.no_subject'), text(messages, 'email_composer.prefix.forward'));

  // The classification label: a required one that isn't there stops the
  // forward before anything is asked.
  await whenPolicySettled();
  const label = automaticLabel({ email: identity.email }, { headers: email.headers, from: email.from });
  if (label.missing) {
    toast.error(text(messages, 'classification.forward_needs_label'));
    return { sent: false, reason: 'stopped' };
  }

  // Ask before the first forward to an address.
  const addresses = to.map((entry) => addressOf(entry).toLowerCase());
  const account = approvalAccount();
  const approved = new Set(forwardApprovals(plugin.id, account));
  const unknown = [...new Set(addresses.filter((a) => !approved.has(a)))];
  if (unknown.length > 0) {
    const vars = { plugin: plugin.name || plugin.id, addresses: unknown.join(', '), subject: email.subject || text(messages, 'email_viewer.no_subject') };
    const allowed = await deps.confirm({
      title: text(messages, 'plugins.forward_approval.title', vars),
      message: text(messages, 'plugins.forward_approval.message', vars),
      confirmLabel: text(messages, 'plugins.forward_approval.allow'),
      cancelLabel: text(messages, 'plugins.dialog.cancel'),
    });
    if (!allowed) return { sent: false, reason: 'declined' };
    saveForwardApprovals(plugin.id, account, [...approved, ...unknown]);
  }

  const context = {
    surface: 'plugin-forward' as const,
    to: addresses,
    cc: [],
    bcc: [],
    fromEmail: identity.email,
    identityId: identity.id,
    sender: { name: identity.name, email: identity.email },
    mode: 'forward' as const,
    plainText: true,
    forwardedSeparator: text(messages, 'quote_header.forwarded_separator'),
  };
  if (!(await runPreSendChecks(context))) return { sent: false, reason: 'stopped' };
  // No plugin step in between, as for a quick reply: both stages at once.
  const body = finalizeOutgoing(finalizeOutgoing({ text: forwardBody(email, note, messages, locale) }, context), context, 'last').text;

  // Always: a required send check that isn't running holds the forward too,
  // also when no plugin listens right now.
  {
    const outcome = await runPluginSendCheck(async (): Promise<OutgoingEmail> => ({
      to, cc: [], bcc: [], subject,
      htmlBody: '',
      textBody: body,
      identityId: identity.id,
      fromEmail: identity.email,
      // The original's parts, read where they are (the message's own account).
      attachments: await inspectAttachments(attachments.map((a) => ({
        name: a.name || 'attachment',
        type: a.type || 'application/octet-stream',
        size: a.size,
        blobId: a.blobId,
        load: (bytes: number) => client.fetchBlobArrayBuffer(a.blobId, a.name || undefined, a.type || undefined, sourceAccountId, bytes),
      }))),
      surface: 'plugin-forward',
      mode: 'forward',
      // The plugin's note is the only text written for this forward.
      authoredText: note,
      externalRecipients: await externalRecipientsFor(context),
    }));
    const guardKey = sendGuardMessageKey(outcome);
    if (guardKey) toast.error(text(messages, `send_guards.${guardKey}`));
    if (outcome !== 'allowed') return { sent: false, reason: 'stopped' };
  }

  // The attachments are blobs of the account the original is in; a message
  // of a team or shared mailbox goes out from the user's own account.
  const sendAccountId = (await client.resolveSendAccountId?.(identity.email)) ?? client.getAccountId();
  const fromAccountId = sourceAccountId ?? client.getAccountId();
  let blobIds = attachments.map((a) => a.blobId);
  if (blobIds.length && fromAccountId !== sendAccountId) {
    const copied = await client.copyBlobs(fromAccountId, blobIds, sendAccountId);
    blobIds = blobIds.map((id) => {
      const copy = copied[id];
      if (!copy) throw new Error(`${method}: the attachments could not be copied to the account that sends`);
      return copy;
    });
  }

  // Last, after the plugins' checks: the label's prefix and headers.
  const labelled = classifyOutgoing(label.policy, label.label, { subject });

  const delaySeconds = useSettingsStore.getState().sendDelaySeconds;
  const delayedUntil = delaySeconds > 0 && client.hasDelayedSend()
    ? new Date(Date.now() + delaySeconds * 1000).toISOString()
    : undefined;
  const result = await useEmailStore.getState().sendEmail(
    client, to, labelled.subject, body, undefined, undefined, identity.id, identity.email, undefined,
    identity.name || undefined, undefined,
    attachments.map((a, i) => ({
      blobId: blobIds[i],
      name: a.name || 'attachment',
      type: a.type || 'application/octet-stream',
      size: a.size,
      disposition: 'attachment' as const,
    })),
    undefined, undefined, delayedUntil, undefined,
    labelled.labelHeaders ? { labelHeaders: labelled.labelHeaders } : undefined,
  );
  announceSent(result, { to: addresses, cc: [], bcc: [], subject: labelled.subject });

  try {
    await deps.markForwarded(emailId, sourceAccountId);
  } catch {
    // The forward went out; a missing $forwarded mark is not worth failing it.
  }
  return {
    sent: true,
    emailId: result.emailId ?? null,
    to: addresses,
    scheduledFor: result.scheduled && result.sendAt ? result.sendAt : null,
  };
}
