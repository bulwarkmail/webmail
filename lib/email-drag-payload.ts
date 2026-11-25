/** Pro tabs need the message's source as well as its JMAP id. */
export const EMAIL_SOURCES_DRAG_MIME = "application/x-bulwark-email-sources";

export interface EmailDragSource {
  emailId: string;
  clientAccountId: string;
  accountId: string;
}

export function parseEmailSourcesPayload(raw: string): EmailDragSource[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is EmailDragSource =>
      entry !== null && typeof entry === "object"
      && typeof entry.emailId === "string" && entry.emailId.length > 0
      && typeof entry.clientAccountId === "string" && entry.clientAccountId.length > 0
      && typeof entry.accountId === "string" && entry.accountId.length > 0,
    );
  } catch {
    return [];
  }
}
