import { withTitleBadge } from '@/lib/title-badge';

/**
 * Visual alerts (Settings > Accessibility): the browser-tab title swaps
 * slowly between the page's own title and a short alert ("3 new messages")
 * while the tab is in the background, for people who can't hear the sound.
 *
 * It never swaps faster than once a second and never flashes colours
 * (WCAG 2.3.1), and it stops after a few rounds or as soon as the tab gets
 * the focus. hooks/use-document-title leaves the title alone while it runs.
 */

/** Time between two swaps. At least a second. */
export const TITLE_ALERT_INTERVAL_MS = 1500;
/** Swaps before it stops by itself: five rounds of alert and title. */
export const TITLE_ALERT_MAX_SWAPS = 10;

let timer: ReturnType<typeof setInterval> | null = null;
let baseTitle = '';
let alertText = '';
let swaps = 0;
let showingAlert = false;

export function isTitleAlertActive(): boolean {
  return timer !== null;
}

function tabInView(): boolean {
  return !document.hidden && document.hasFocus();
}

function onVisibilityChange() {
  if (tabInView()) stopTitleAlert();
}

/**
 * Starts the alert, or changes its text and starts its rounds again when
 * it is already running. Nothing happens while the tab is in front: the
 * toast or the list says it there.
 */
export function startTitleAlert(text: string): void {
  if (typeof document === 'undefined' || !text) return;
  if (tabInView()) return;
  alertText = text;
  swaps = 0;
  if (timer !== null) {
    if (showingAlert) document.title = withTitleBadge(alertText);
    return;
  }
  const badge = withTitleBadge('');
  baseTitle = badge && document.title.startsWith(badge) ? document.title.slice(badge.length) : document.title;
  showingAlert = true;
  document.title = withTitleBadge(alertText);
  timer = setInterval(() => {
    swaps += 1;
    if (swaps >= TITLE_ALERT_MAX_SWAPS) {
      stopTitleAlert();
      return;
    }
    showingAlert = !showingAlert;
    document.title = withTitleBadge(showingAlert ? alertText : baseTitle);
  }, TITLE_ALERT_INTERVAL_MS);
  window.addEventListener('focus', stopTitleAlert);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/** Stops the alert and puts the page's title back. */
export function stopTitleAlert(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  showingAlert = false;
  window.removeEventListener('focus', stopTitleAlert);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  // useDocumentTitle sees the change and writes the current title if the
  // page moved on in the meantime.
  document.title = withTitleBadge(baseTitle);
}
