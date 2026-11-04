// Host side of api.compose.open and api.drafts.create. compose.open fills
// the composer the way an in-app mailto: link does, and the user still has
// to press Send; drafts.create saves a draft to the Drafts folder without
// opening anything. Neither sends mail.

import { goInApp } from './page-navigation';
import type { ComposeInput, DraftInput, InstalledPlugin } from '../plugin-types';
import type { ParsedMailto } from '../protocol-handlers/mailto';
import { requestInternalCompose } from '../protocol-handlers/mailto';
import { notifyPendingMailto, savePendingMailto } from '../protocol-handlers/session';
import { getPathPrefix } from '../browser-navigation';
import { locales } from '@/i18n/routing';
import { useIdentityStore } from '@/stores/identity-store';
import { sanitizePluginBodyHtml } from '../email-sanitization';
import { htmlToPlainText } from '../html-to-text';
import {
  readAddressList, readBlobRefs, readBoolean, readId, readObject, readString, sessionClient, withinRate,
  type PluginBlobRef,
} from './host-api-input';

/** Most recipients (to, cc and bcc together) one call may set. */
export const MAX_PLUGIN_RECIPIENTS = 100;
/** Most attachments one call may add. */
export const MAX_PLUGIN_ATTACHMENTS = 20;
const MAX_SUBJECT = 998;
const MAX_BODY = 512 * 1024;
// A blob a plugin uploaded can be as big as the server lets it be; this
// only keeps the number sane.
const MAX_ATTACHMENT_SIZE = 2 ** 31;

interface MessageFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | undefined;
  attachments: PluginBlobRef[];
}

function readMessage(method: string, data: Record<string, unknown>): MessageFields {
  const to = readAddressList(data.to, method, 'to', MAX_PLUGIN_RECIPIENTS);
  const cc = readAddressList(data.cc, method, 'cc', MAX_PLUGIN_RECIPIENTS);
  const bcc = readAddressList(data.bcc, method, 'bcc', MAX_PLUGIN_RECIPIENTS);
  if (to.length + cc.length + bcc.length > MAX_PLUGIN_RECIPIENTS) {
    throw new Error(`${method}: at most ${MAX_PLUGIN_RECIPIENTS} recipients in all`);
  }
  const subject = data.subject === undefined ? '' : readString(data.subject, method, 'subject', MAX_SUBJECT);
  // eslint-disable-next-line no-control-regex -- a subject is one header line
  if (/[\u0000-\u001f\u007f]/.test(subject)) throw new Error(`${method}: subject must be one line`);
  const body = data.body === undefined ? '' : readString(data.body, method, 'body', MAX_BODY);
  const isHtml = data.isHtml === undefined ? false : readBoolean(data.isHtml, method, 'isHtml');
  const html = isHtml ? sanitizePluginBodyHtml(body) : undefined;
  return {
    to, cc, bcc, subject,
    text: html !== undefined ? htmlToPlainText(html) : body,
    html,
    attachments: readBlobRefs(data.attachments, method, MAX_PLUGIN_ATTACHMENTS, MAX_ATTACHMENT_SIZE),
  };
}

// ─── compose.open ─────────────────────────────────────────────

const COMPOSE_PER_MINUTE = 5;

/** The mail page in the current mount and locale. */
function mailPageHref(): string {
  const segments = window.location.pathname.split('/').filter(Boolean);
  const localeIndex = segments.findIndex((s) => (locales as readonly string[]).includes(s));
  if (localeIndex >= 0) return '/' + segments.slice(0, localeIndex + 1).join('/') + '/';
  return getPathPrefix() + '/';
}

/**
 * Open the composer filled in. On the mail page it opens in place (asking
 * first when a draft is already open); elsewhere the app goes to the mail
 * page, which opens it. Resolves to 'opened' or 'navigating'.
 */
export function doComposeOpen(plugin: InstalledPlugin, input: unknown): 'opened' | 'navigating' {
  const method = 'compose.open';
  const data = readObject(input, method, 'message', ['to', 'cc', 'bcc', 'subject', 'body', 'isHtml', 'attachments'], true) as ComposeInput & Record<string, unknown>;
  const message = readMessage(method, data);
  if (!withinRate('compose', plugin.id, COMPOSE_PER_MINUTE)) {
    throw new Error(`${method}: at most ${COMPOSE_PER_MINUTE} times a minute`);
  }
  const draft: ParsedMailto = {
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    body: message.text,
    ...(message.html !== undefined ? { htmlBody: message.html } : {}),
    ...(message.attachments.length ? { attachments: message.attachments } : {}),
  };
  if (requestInternalCompose(draft)) return 'opened';
  // No mail page on screen: park the draft where the mail page looks for an
  // incoming mailto: request when it mounts, and go there.
  savePendingMailto(draft);
  notifyPendingMailto();
  goInApp('/', mailPageHref());
  return 'navigating';
}

// ─── compose.reply ────────────────────────────────────────────

/** Asks the mail page to reply to the open message (components/mail/mail-app.tsx). */
export const PLUGIN_REPLY_EVENT = 'bulwark:plugin-reply';

export interface PluginReplyRequest {
  emailId: string;
  text: string;
  all: boolean;
}

/**
 * Reply (or reply to all) to the message open in the reader, with `text` as
 * the start of the reply, the way the reader's own quick reply does. Only
 * the open message: a plugin can't start replies to mail the user isn't
 * looking at. Resolves to true when the composer opened.
 */
export function doComposeReply(plugin: InstalledPlugin, emailId: unknown, input: unknown): boolean {
  const method = 'compose.reply';
  const id = readId(emailId, method, 'emailId');
  const data = readObject(input, method, 'reply', ['text', 'all'], true);
  const text = data.text === undefined ? '' : readString(data.text, method, 'text', MAX_BODY);
  const all = data.all === undefined ? false : readBoolean(data.all, method, 'all');
  if (!withinRate('compose', plugin.id, COMPOSE_PER_MINUTE)) {
    throw new Error(`${method}: at most ${COMPOSE_PER_MINUTE} times a minute`);
  }
  const uncancelled = window.dispatchEvent(new CustomEvent<PluginReplyRequest>(PLUGIN_REPLY_EVENT, {
    detail: { emailId: id, text, all },
    cancelable: true,
  }));
  if (uncancelled) throw new Error(`${method}: the message is not open in the reader`);
  return true;
}

// ─── drafts.create ────────────────────────────────────────────

const DRAFTS_PER_MINUTE = 10;

/** Save a draft in the Drafts folder, from the user's default identity. Resolves to its id. */
export async function doDraftsCreate(plugin: InstalledPlugin, input: unknown): Promise<string> {
  const method = 'drafts.create';
  const data = readObject(input, method, 'draft', ['to', 'cc', 'bcc', 'subject', 'body', 'isHtml', 'attachments'], true) as DraftInput & Record<string, unknown>;
  const message = readMessage(method, data);
  const client = sessionClient(method);
  const { identities, preferredPrimaryId } = useIdentityStore.getState();
  const identity = identities.find((i) => i.id === preferredPrimaryId) ?? identities[0];
  if (!identity) throw new Error(`${method}: the account has no sender address to save the draft from`);
  if (!withinRate('drafts', plugin.id, DRAFTS_PER_MINUTE)) {
    throw new Error(`${method}: at most ${DRAFTS_PER_MINUTE} drafts a minute`);
  }
  return client.createDraft(
    message.to,
    message.subject,
    message.text,
    message.cc,
    message.bcc,
    identity.id,
    identity.email,
    undefined,
    message.attachments.map((a) => ({ ...a, disposition: 'attachment' as const })),
    identity.name || undefined,
    message.html,
  );
}
