import type { ComposerDraftData } from "@/components/email/email-composer";
import type { ParsedMailto } from "@/lib/protocol-handlers/mailto";
import { plainTextToComposerBody } from "@/lib/email-composer-utils";

/**
 * The composer draft for an in-app mailto: request or a plugin's
 * api.compose.open. A plain body follows the "plain text only" setting; an
 * HTML body (only a plugin sends one, sanitised by the host) opens in HTML
 * mode whatever that setting says. Attachments a plugin uploaded come along
 * as blob references, like those of a re-opened draft.
 */
export function mailtoComposerDraft(pending: ParsedMailto, plainTextMode: boolean): ComposerDraftData {
  const isHtml = typeof pending.htmlBody === "string";
  const body = isHtml
    ? pending.htmlBody!
    : plainTextMode
      ? pending.body
      : plainTextToComposerBody(pending.body);
  return {
    to: pending.to.join(", "),
    cc: pending.cc.join(", "),
    bcc: pending.bcc.join(", "),
    subject: pending.subject,
    body,
    showCc: pending.cc.length > 0,
    showBcc: pending.bcc.length > 0,
    selectedIdentityId: null,
    subAddressTag: "",
    mode: "compose",
    draftId: null,
    ...(isHtml ? { plainTextMode: false } : {}),
    ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
    ...(pending.linkParams ? { linkParams: pending.linkParams } : {}),
  };
}
