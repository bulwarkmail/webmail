/**
 * The updater's text in the interface language, by its keys in the shell's
 * src/main/strings.ts. The shell fills in the {placeholders} itself, so they go through as
 * they are. It goes out with the rest of the labels in shellLabels (languages.ts).
 */
export function updateLabels(t: (key: string, values?: Record<string, string>) => string): Record<string, string> {
  const keep = { version: '{version}', current: '{current}', target: '{target}' };
  return {
    menuRestartToUpdate: t('desktop_updates.shell_restart'),
    menuCheckForUpdates: t('desktop_updates.shell_check'),
    menuUpdateAvailable: t('desktop_updates.shell_available', keep),
    updateReadyTitle: t('desktop_updates.shell_ready_title'),
    updateReadyBody: t('desktop_updates.shell_ready_body', keep),
    updateAvailableTitle: t('desktop_updates.shell_available_title'),
    updateNoneTitle: t('desktop_updates.shell_none_title'),
    updateNoneDetail: t('desktop_updates.shell_none_detail', keep),
    updateFailedTitle: t('desktop_updates.shell_failed_title'),
    updateFailedDetail: t('desktop_updates.shell_failed_detail'),
    updateBetaTitle: t('desktop_updates.shell_beta_title'),
    updateBetaDetail: t('desktop_updates.shell_beta_detail'),
    updateBetaConfirm: t('desktop_updates.shell_beta_confirm'),
    updateOlderTitle: t('desktop_updates.shell_older_title', keep),
    updateOlderDetail: t('desktop_updates.shell_older_detail', keep),
    updateOlderConfirm: t('desktop_updates.shell_older_confirm'),
  };
}
