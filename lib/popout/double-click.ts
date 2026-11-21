import type { MessageDoubleClick } from '@/stores/settings-store';

/**
 * Whether a double-click on a message in the list opens it in a window of
 * its own (#1814): only where that is on offer and not on a phone. The
 * desktop app follows its own switch (Settings > desktop windows),
 * everywhere else the Reading setting "Double-click a message".
 */
export function doubleClickOpensWindow(opts: {
  canOpenWindow: boolean;
  isMobile: boolean;
  desktopApp: boolean;
  desktopOpenOnDoubleClick: boolean;
  messageDoubleClick: MessageDoubleClick;
}): boolean {
  if (!opts.canOpenWindow || opts.isMobile) return false;
  return opts.desktopApp ? opts.desktopOpenOnDoubleClick : opts.messageDoubleClick === 'new-window';
}
