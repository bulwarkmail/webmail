/**
 * What "Empty Trash" / "Empty Spam" is called and what its confirm says, as
 * keys of the root catalogue. The confirm counts the messages that go
 * (usability test 2026-11-04, p2-14). Any other folder's "Empty folder…"
 * names the folder and the count too (#1785); without a name (a plugin
 * asking) it keeps the old wording.
 */
export function emptyFolderLabelKey(role: string | null | undefined): string | null {
  if (role === "trash") return "mail_p2_folders.empty_trash";
  if (role === "junk") return "mail_p2_folders.empty_spam";
  return null;
}

export interface EmptyFolderPrompt {
  title: string;
  message: string;
  values?: Record<string, number | string>;
  confirm: string;
}

export function emptyFolderPrompt(
  mailbox: { role?: string | null; totalEmails?: number },
  movesToTrash: boolean,
  folderName?: string,
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
  if (folderName) {
    const values = { folder: folderName, count: mailbox.totalEmails ?? 0 };
    return movesToTrash
      ? { title: "mail_p2_folders.empty_folder_title", message: "mail_p2_folders.empty_folder_confirm_trash", values, confirm: "mail_p2_folders.empty_folder_move" }
      : { title: "mail_p2_folders.empty_folder_title", message: "mail_p2_folders.empty_folder_confirm_delete", values, confirm: "mail_p2_folders.empty_folder_delete" };
  }
  return {
    title: "email_list.empty_folder.confirm_title",
    message: movesToTrash ? "email_list.empty_folder.confirm_message_trash" : "email_list.empty_folder.confirm_message",
    confirm: "email_list.empty_folder.confirm_button",
  };
}
