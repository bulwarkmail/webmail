/**
 * What "Empty Trash" / "Empty Spam" is called and what its confirm says, as
 * keys of the root catalogue. The confirm counts the messages that go
 * (usability test 2026-11-04, p2-14). Other folders keep the old wording:
 * nothing in the app offers to empty them, but a plugin can still ask.
 */
export function emptyFolderLabelKey(role: string | null | undefined): string | null {
  if (role === "trash") return "mail_p2_folders.empty_trash";
  if (role === "junk") return "mail_p2_folders.empty_spam";
  return null;
}

export interface EmptyFolderPrompt {
  title: string;
  message: string;
  values?: Record<string, number>;
  confirm: string;
}

export function emptyFolderPrompt(
  mailbox: { role?: string | null; totalEmails?: number },
  movesToTrash: boolean,
): EmptyFolderPrompt {
  const label = emptyFolderLabelKey(mailbox.role);
  if (label) {
    return {
      title: label,
      message: mailbox.role === "trash" ? "mail_p2_folders.empty_trash_confirm" : "mail_p2_folders.empty_spam_confirm",
      values: { count: mailbox.totalEmails ?? 0 },
      confirm: label,
    };
  }
  return {
    title: "email_list.empty_folder.confirm_title",
    message: movesToTrash ? "email_list.empty_folder.confirm_message_trash" : "email_list.empty_folder.confirm_message",
    confirm: "email_list.empty_folder.confirm_button",
  };
}
