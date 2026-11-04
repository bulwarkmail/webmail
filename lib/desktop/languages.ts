/**
 * What the shell's menus and spellcheck should speak. The interface language and
 * its translations of the menus come from the host, and each open composer adds the
 * language its text is in, so spelling is checked in what's being written.
 */

import { getDesktopBridge } from './bridge';
import { certificateLabels } from './certificate-labels';
import { updateLabels } from './update-labels';

let ui = '';
let labels: Record<string, string> | undefined;
const composers = new Map<string, string>();

function push(): void {
  const shell = getDesktopBridge()?.shell;
  if (!shell?.setLanguages || !ui) return;
  shell.setLanguages({ ui, composer: [...new Set(composers.values())], labels });
}

export function setDesktopInterfaceLanguage(language: string, translated: Record<string, string>): void {
  ui = language;
  labels = translated;
  push();
}

/** With null, this composer has gone. */
export function noteComposerLanguage(key: string, language: string | null): void {
  if (language) {
    if (composers.get(key) === language) return;
    composers.set(key, language);
  } else if (!composers.delete(key)) {
    return;
  }
  push();
}

/**
 * The shell's text in the interface language, by its keys in src/main/strings.ts. The
 * shell fills in `{word}` and `{count}` itself when it shows them, so they go over as
 * they are. Without a value next-intl gives back the key, and that would be the label.
 */
export function shellLabels(t: (key: string, values?: Record<string, string>) => string): Record<string, string> {
  return {
    ...updateLabels(t),
    ...certificateLabels(t),
    editCancel: t('desktopEdit.cancel'),
    editDiscardTitle: t('desktopEdit.discard_title', { name: '{name}' }),
    editDiscardDetail: t('desktopEdit.discard_detail'),
    editDiscardConfirm: t('desktopEdit.discard_confirm'),
    editClearTitle: t('desktopEdit.clear_title'),
    editClearConfirm: t('desktopEdit.clear_confirm'),
    editSignOutTitle: t('desktopEdit.signout_title'),
    editSignOutConfirm: t('desktopEdit.signout_confirm'),
    editSignOutChanged: t('desktopEdit.signout_changed', { names: '{names}' }),
    editSignOutHeld: t('desktopEdit.signout_held', { names: '{names}' }),
    editOutsideNote: t('desktopEdit.outside_note'),
    menuFile: t('desktopUi.menu.file'),
    menuEdit: t('desktopUi.menu.edit'),
    menuView: t('desktopUi.menu.view'),
    menuMessage: t('desktopUi.menu.message'),
    menuGo: t('desktopUi.menu.go'),
    menuWindow: t('desktopUi.menu.window'),
    menuHelp: t('desktopUi.menu.help'),
    menuNewMessage: t('email_composer.new_message'),
    menuQuickCompose: t('desktopQuickCompose.menu'),
    menuNewWindow: t('desktopUi.menu.new_window'),
    menuPrint: t('desktopUi.menu.print'),
    menuSavePdf: t('desktopUi.menu.save_pdf'),
    menuSwitchMode: t('desktopUi.menu.switch_connection'),
    menuClose: t('desktopUi.menu.close'),
    menuQuit: t('desktopUi.menu.quit'),
    menuUndo: t('desktopUi.menu.undo'),
    menuRedo: t('desktopUi.menu.redo'),
    menuCut: t('desktopUi.menu.cut'),
    menuCopy: t('desktopUi.menu.copy'),
    menuPaste: t('desktopUi.menu.paste'),
    menuSelectAll: t('desktopUi.menu.select_all'),
    menuSearch: t('desktopUi.menu.search'),
    menuRefresh: t('desktopUi.menu.refresh'),
    menuReadingPane: t('desktopUi.menu.reading_pane'),
    menuPaneRight: t('desktopUi.menu.pane_right'),
    menuPaneBelow: t('desktopUi.menu.pane_below'),
    menuPaneOff: t('desktopUi.menu.pane_off'),
    menuZoomIn: t('desktopUi.menu.zoom_in'),
    menuZoomOut: t('desktopUi.menu.zoom_out'),
    menuZoomReset: t('desktopUi.menu.zoom_reset'),
    menuFullScreen: t('desktopUi.menu.full_screen'),
    menuReply: t('context_menu.reply'),
    menuReplyAll: t('context_menu.reply_all'),
    menuForward: t('context_menu.forward'),
    menuMarkRead: t('context_menu.mark_read'),
    menuMarkUnread: t('context_menu.mark_unread'),
    menuStar: t('context_menu.star'),
    menuMove: t('context_menu.move_to_dialog'),
    menuArchive: t('context_menu.archive'),
    menuSpam: t('context_menu.mark_as_spam'),
    menuDelete: t('context_menu.delete'),
    menuOpenInWindow: t('desktopUi.menu.open_in_window'),
    menuGoInbox: t('sidebar.mailboxes.inbox'),
    menuGoSent: t('sidebar.mailboxes.sent'),
    menuGoDrafts: t('sidebar.mailboxes.drafts'),
    menuGoNext: t('desktopUi.menu.next_message'),
    menuGoPrevious: t('desktopUi.menu.previous_message'),
    menuGoNextUnread: t('desktopUi.menu.next_unread'),
    menuGoMail: t('desktopUi.menu.mail'),
    menuGoCalendar: t('sidebar.calendar'),
    menuGoContacts: t('sidebar.contacts'),
    menuGoFiles: t('desktopUi.menu.files'),
    menuGoBack: t('desktopUi.menu.back'),
    menuGoForward: t('desktopUi.menu.forward'),
    menuMinimize: t('desktopUi.menu.minimize'),
    menuCycle: t('desktopUi.menu.next_window'),
    menuShortcuts: t('desktopUi.menu.shortcuts'),
    menuDocs: t('desktopUi.menu.docs'),
    menuSettings: t('desktopUi.menu.settings'),
    menuAbout: t('desktopUi.menu.about'),
    contextCut: t('desktopUi.menu.cut'),
    contextCopy: t('desktopUi.menu.copy'),
    contextPaste: t('desktopUi.menu.paste'),
    contextSelectAll: t('desktopUi.menu.select_all'),
    contextAddToDictionary: t('desktopUi.context.add_to_dictionary', { word: '{word}' }),
    contextNoSuggestions: t('desktopUi.context.no_suggestions'),
    contextOpenLink: t('desktopUi.context.open_link'),
    contextCopyLink: t('desktopUi.context.copy_link'),
    contextCopyAddress: t('desktopUi.context.copy_address'),
    contextSaveImage: t('desktopUi.context.save_image'),
    contextCopyImage: t('desktopUi.context.copy_image'),
    unsavedTitle: t('desktopUi.closing.unsaved_title'),
    unsavedDetail: t('desktopUi.closing.unsaved_detail'),
    closeAnyway: t('desktopUi.closing.close_anyway'),
    unsentTitle: t('desktopUi.closing.unsent_title'),
    unsentOne: t('desktopUi.closing.unsent_one'),
    unsentMany: t('desktopUi.closing.unsent_many', { count: '{count}' }),
    closeNow: t('desktopUi.closing.quit'),
    leaveTitle: t('desktopUi.closing.leave_title'),
    leaveDetail: t('desktopUi.closing.leave_detail'),
    leave: t('desktopUi.closing.leave'),
    stay: t('desktopUi.closing.stay'),
  };
}

/** Test helper. */
export function resetDesktopLanguages(): void {
  ui = '';
  labels = undefined;
  composers.clear();
}
