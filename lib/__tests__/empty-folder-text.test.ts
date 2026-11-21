import { describe, expect, it } from 'vitest';
import { emptyFolderLabelKey, emptyFolderPrompt } from '../empty-folder-text';

// p2-14: the confirm said "All emails in this folder will be permanently
// deleted" with no number; it now says how many, and names Trash or Spam.

describe('emptyFolderPrompt', () => {
  it('names Trash and counts its messages', () => {
    expect(emptyFolderPrompt({ role: 'trash', totalEmails: 146 }, false)).toEqual({
      title: 'mail_p2_folders.empty_trash',
      message: 'mail_p2_folders.empty_trash_confirm',
      values: { count: 146 },
      confirm: 'mail_p2_folders.empty_trash',
    });
  });

  it('names Spam and counts its messages', () => {
    const prompt = emptyFolderPrompt({ role: 'junk', totalEmails: 3 }, false);
    expect(prompt.title).toBe('mail_p2_folders.empty_spam');
    expect(prompt.message).toBe('mail_p2_folders.empty_spam_confirm');
    expect(prompt.values).toEqual({ count: 3 });
  });

  it('names any other folder and counts its messages (#1785)', () => {
    expect(emptyFolderPrompt({ role: null, totalEmails: 7 }, true, 'Receipts')).toEqual({
      title: 'mail_p2_folders.empty_folder_title',
      message: 'mail_p2_folders.empty_folder_confirm_trash',
      values: { folder: 'Receipts', count: 7 },
      confirm: 'mail_p2_folders.empty_folder_move',
    });
    expect(emptyFolderPrompt({ role: null, totalEmails: 7 }, false, 'Receipts').message).toBe('mail_p2_folders.empty_folder_confirm_delete');
  });

  it('keeps the old wording for other folders without a name', () => {
    expect(emptyFolderPrompt({ role: null, totalEmails: 3 }, true).message).toBe('email_list.empty_folder.confirm_message_trash');
    expect(emptyFolderLabelKey('inbox')).toBeNull();
  });
});
