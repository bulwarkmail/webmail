/**
 * Localizes the display name of special-use mailboxes.
 *
 * Mail servers (e.g. Stalwart) always create system folders with English
 * names — "Inbox", "Sent", "Junk" — regardless of the account locale. JMAP
 * exposes the special-use semantics via the mailbox `role`, so we map that
 * role onto a translated label (mirroring Roundcube's behaviour). Folders
 * without a recognized role — i.e. user-created folders — keep their server
 * name untouched.
 *
 * The keys live under the `sidebar.mailboxes` namespace; `junk`, `flagged`
 * and `all` reuse the existing `spam`/`starred`/`all_mail` keys so every
 * locale already has a translation.
 */
const ROLE_TRANSLATION_KEY: Record<string, string> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  archive: "archive",
  junk: "spam",
  important: "important",
  flagged: "starred",
  all: "all_mail",
};

/**
 * Returns the localized name for a mailbox, or its raw server name when the
 * role is unknown/absent.
 *
 * @param translate Resolves a `sidebar.mailboxes` leaf key (e.g. `"inbox"`) to
 *   its localized string. Callers scoped to the `sidebar` namespace pass
 *   `(k) => t(`mailboxes.${k}`)`; root-scoped callers pass
 *   `(k) => t(`sidebar.mailboxes.${k}`)`.
 */
export function localizeMailboxName(
  role: string | undefined | null,
  name: string,
  translate: (key: string) => string,
): string {
  if (!role) return name;
  const key = ROLE_TRANSLATION_KEY[role];
  return key ? translate(key) : name;
}
