/**
 * Whether "Report spam" makes sense for mail in a folder of this role. Not on
 * your own outgoing mail (Sent, Drafts, Scheduled), and not in Trash, where
 * the mail is already thrown out.
 */
export function spamApplicableIn(role: string | null | undefined): boolean {
  return !["sent", "drafts", "scheduled", "trash"].includes(role || "");
}
