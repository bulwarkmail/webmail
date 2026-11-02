/**
 * The classification label stage of sending (enterprise pack item 3).
 * Every surface that sends a user's mail runs it last, after plugins'
 * onTransformOutgoingEmail, so a plugin can't drop or change the label:
 *
 * - the composer (inline, pop-out and Pro tab), with the user's pick;
 * - quick reply, with the original's label, else the default;
 * - a plugin's forward (api.email.forward), the same way.
 *
 * A required label fails closed: with none, the stage throws
 * LabelRequiredError and nothing is sent. Labels come from the policy of
 * the account and identity the mail goes out from, never just the active
 * account. Automatic mail carries none: calendar invitations and RSVP
 * replies, read receipts, List-Unsubscribe mails and phishing reports.
 *
 * S/MIME and PGP plugins take over the send (onComposeSend) and build raw
 * MIME themselves: the composer hands them the prefixed subject, and
 * lib/outgoing/classification-raw.ts puts the label into what they send.
 */

import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { subjectForAccount } from '@/lib/org/account-subjects';
import { policyForSender } from '@/lib/org/signature-state';
import { activeExternalMailContext, contextInternalDomains, externalSenders, isOtherAccount } from '@/lib/external-mail';
import { cachedIdentitiesForAccount } from '@/hooks/use-pro-multi-account-identities';
import { usePolicyStore } from '@/stores/policy-store';
import { withoutLabelHeaders } from './custom-headers';
import {
  applyLabelPrefix,
  labelHeaderProperties,
  draftLabelChoice,
  receivedLabel,
  type LabelsPolicy,
} from '@/lib/classification/labels';

/** A send stopped because the organisation requires a label and none was picked. */
export class LabelRequiredError extends Error {
  constructor() {
    super('A classification label is required');
    this.name = 'LabelRequiredError';
  }
}

export function isLabelRequiredError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'LabelRequiredError';
}

export interface LabelSender {
  /** The From identity's address (a group's own picks the group's scopes). */
  email?: string;
  /** The signed-in account (AccountEntry id) it goes out through; the active one when left out. */
  accountId?: string | null;
}

/** The labels section that applies to mail from `sender`, read from the stores now. */
export function labelsPolicyFor(sender: LabelSender): LabelsPolicy {
  const policy = policyForSender(usePolicyStore.getState(), sender.email, subjectForAccount(sender.accountId));
  return policy.organisation?.labels ?? DEFAULT_ORGANISATION_POLICY.labels;
}

/** The message a reply or forward answers, as far as its label goes. */
export interface OriginalMessage {
  /** Its headers (labelSourceHeaders keeps the ones that matter). */
  headers?: Record<string, string | string[]> | null;
  from?: ReadonlyArray<{ email?: string | null }> | null;
  /** The signed-in account it was received in; the active one when left out. */
  accountId?: string | null;
}

/**
 * Whether every From address of a message is inside the organisation of
 * the account that received it (its identities' domains and the admin's
 * organisation domains). False without a From or without known domains.
 */
export function senderIsInternal(
  from: OriginalMessage['from'],
  accountId?: string | null,
): boolean {
  if (!from || from.length === 0) return false;
  const context = isOtherAccount(accountId)
    ? {
        policy: (usePolicyStore.getState().resolveFor(subjectForAccount(accountId)).organisation
          ?? DEFAULT_ORGANISATION_POLICY).externalMail,
        identityEmails: (cachedIdentitiesForAccount(accountId) ?? []).map((identity) => identity.email),
      }
    : activeExternalMailContext();
  const internal = contextInternalDomains(context);
  return internal.length > 0 && externalSenders(from, internal).length === 0;
}

/**
 * The label a reply or forward takes over from its original: the
 * original's known label, only when an internal sender set it (anyone
 * outside can write the header) and never one below the default (the
 * list runs from least to most protected).
 */
export function originalLabel(policy: LabelsPolicy, original: OriginalMessage | null | undefined): ClassificationLabel | null {
  if (!original?.headers || policy.list.length === 0) return null;
  const label = receivedLabel(original.headers, policy);
  if (!label || !senderIsInternal(original.from, original.accountId)) return null;
  const floor = policy.list.findIndex((l) => l.id === policy.defaultId);
  return floor >= 0 && policy.list.indexOf(label) < floor ? null : label;
}

/**
 * The label a message goes out with. `choice`: the user's pick (an id),
 * null for "no label", undefined when they picked nothing, which takes the
 * original's label (originalLabel), else the default. A pick that isn't in
 * the list (another account's, an old one) counts as nothing picked.
 */
export function resolveLabel(
  policy: LabelsPolicy,
  choice: string | null | undefined,
  original?: OriginalMessage | null,
): ClassificationLabel | null {
  if (policy.list.length === 0) return null;
  if (choice === null) return null;
  const picked = choice ? policy.list.find((label) => label.id === choice) : undefined;
  if (picked) return picked;
  return originalLabel(policy, original) ?? policy.list.find((label) => label.id === policy.defaultId) ?? null;
}

/**
 * The pick a message opened again in the composer starts with: a draft's
 * X-Bulwark-Label, else the label its headers carry (a sent message
 * brought back by Undo, "Cancel and edit" or edit-as-new carries SIO-Label
 * only), read with the labels of the account it is in.
 */
export function reopenedLabelChoice(
  headers: Record<string, string | string[]> | null | undefined,
  accountId?: string | null,
): string | null | undefined {
  const marked = draftLabelChoice(headers);
  if (marked !== undefined) return marked;
  return receivedLabel(headers, labelsPolicyFor({ accountId }))?.id;
}

/** Whether sending needs a label that `label` doesn't give. */
export function labelMissing(policy: LabelsPolicy, label: ClassificationLabel | null): boolean {
  return policy.required && policy.list.length > 0 && !label;
}

export interface LabelledMessage {
  subject: string;
  /** The plugins' headers, without any the label writes. */
  headers?: Record<string, string>;
  /** The label's headers as JMAP create properties (SubmissionSendOptions.labelHeaders). */
  labelHeaders?: Record<string, string>;
}

/**
 * The stage: the subject with the label's prefix (once), the plugins'
 * headers without the label's names, and the label's headers. Throws
 * LabelRequiredError when the policy requires a label and there is none.
 */
export function classifyOutgoing(
  policy: LabelsPolicy,
  label: ClassificationLabel | null,
  message: { subject: string; headers?: Record<string, string> },
): LabelledMessage {
  if (policy.list.length === 0) return { subject: message.subject, headers: message.headers };
  if (labelMissing(policy, label)) throw new LabelRequiredError();
  const reserved = policy.extraHeader ? [policy.extraHeader] : [];
  return {
    subject: applyLabelPrefix(message.subject, label, policy.list),
    headers: withoutLabelHeaders(message.headers, reserved),
    labelHeaders: label ? labelHeaderProperties(label, policy.extraHeader) : undefined,
  };
}

/** The label of a quick reply or a plugin's forward: the original's (originalLabel), else the default. */
export function automaticLabel(
  sender: LabelSender,
  original?: OriginalMessage | null,
): { policy: LabelsPolicy; label: ClassificationLabel | null; missing: boolean } {
  const policy = labelsPolicyFor(sender);
  const label = resolveLabel(policy, undefined, original);
  return { policy, label, missing: labelMissing(policy, label) };
}

/**
 * The original's headers a reply or forward needs for its label: SIO-Label
 * and every extra header name any scope of the policy uses. Small enough
 * to keep in a Pro tab's saved state.
 */
export function labelSourceHeaders(headers: Record<string, string | string[]> | null | undefined): Record<string, string | string[]> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const raw = usePolicyStore.getState().rawPolicy;
  const names = new Set(['sio-label']);
  const add = (name: string | undefined) => { if (name) names.add(name.toLowerCase()); };
  add(raw.organisation?.labels?.extraHeader);
  for (const scope of raw.scopes ?? []) add(scope.policy.organisation?.labels?.extraHeader);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (names.has(name.toLowerCase())) out[name] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}
