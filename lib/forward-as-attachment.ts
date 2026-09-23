import type { Email } from "@/lib/jmap/types";
import { buildForwardSubject } from "@/lib/subject-prefix";
import { emailExportFilename, type EmailFilenameOptions } from "@/lib/download-filename";

export interface ForwardAsAttachmentEntry {
  blobId: string;
  name: string;
  type: "message/rfc822";
  size: number;
}

export interface ForwardAsAttachmentPayload {
  subject: string;
  attachment: ForwardAsAttachmentEntry;
}

export interface BatchForwardAsAttachmentPayload {
  subject: string;
  attachments: ForwardAsAttachmentEntry[];
}

/**
 * Build the subject and synthetic attachment entry for forwarding a
 * message as a message/rfc822 attachment instead of inline-quoted text
 * (e.g. reporting spam to an upstream gateway that expects the raw
 * original as an attachment, or preserving exact formatting/headers).
 *
 * Referenced by blobId, not re-uploaded - JMAP blobs are account-scoped,
 * not per-email, so the same blobId a message already has can be attached
 * to a brand new outgoing email directly.
 *
 * `filenameOptions`, when passed, carries the user's configured space/case/
 * diacritics transforms (see useSettingsStore's filenameSpaceReplacement
 * and friends) for consistency with "Export as .eml" / drag-out. Its
 * `template`, if any, is ignored: this attachment goes out to a possibly
 * external recipient (spam gateway, another person), so the filename is
 * always just "{date}-{subject}.eml" - never the user's own from/to naming
 * template, which could otherwise leak sender/recipient names into an
 * attachment filename visible to that recipient.
 *
 * Returns null when the email has no blobId (nothing to reference).
 */
export function buildForwardAsAttachmentPayload(
  email: Email,
  forwardPrefix: string,
  filenameOptions?: EmailFilenameOptions,
): ForwardAsAttachmentPayload | null {
  if (!email.blobId) return null;

  return {
    // Match the normal Forward flow's getInitialSubject(), which leaves the
    // subject blank rather than prefix-only when the original has none -
    // buildForwardSubject("", prefix) would otherwise return just the bare
    // prefix (e.g. "Fwd:") for a subject-less message.
    subject: email.subject ? buildForwardSubject(email.subject, forwardPrefix) : "",
    attachment: {
      blobId: email.blobId,
      name: emailExportFilename(email, { ...filenameOptions, template: "{date}-{subject}" }),
      type: "message/rfc822",
      size: email.size,
    },
  };
}

/**
 * Batch sibling of buildForwardAsAttachmentPayload: one composer carrying
 * every selected message as its own message/rfc822 attachment. The subject is
 * count-based (there is no single original subject): `countLabel(n)` returns
 * the localized phrase for n messages (e.g. "3 emails") and is called with
 * the number actually attached, so the subject never claims more attachments
 * than the composer carries. Emails without a blobId are skipped; returns
 * null when none of them has one (same silent no-op as the single flow).
 *
 * Attachments keep the input list order so the composer shows them in the
 * same order the list did. Per-message "{date}-{subject}" filenames would
 * collide only when two messages share subject AND receivedAt-to-the-second
 * - rare enough to tolerate (JMAP accepts duplicate part names), so no
 * dedupe suffix.
 */
export function buildBatchForwardAsAttachmentPayload(
  emails: Email[],
  forwardPrefix: string,
  countLabel: (count: number) => string,
  filenameOptions?: EmailFilenameOptions,
): BatchForwardAsAttachmentPayload | null {
  const attachable = emails.filter((email) => email.blobId);
  if (attachable.length === 0) return null;

  return {
    subject: buildForwardSubject(countLabel(attachable.length), forwardPrefix),
    attachments: attachable.map((email) => ({
      blobId: email.blobId!,
      name: emailExportFilename(email, { ...filenameOptions, template: "{date}-{subject}" }),
      type: "message/rfc822" as const,
      size: email.size,
    })),
  };
}
