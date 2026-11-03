/**
 * Opens pop-out windows: one message, or a composer. Shared with the desktop
 * app's quick compose, which only has to call openComposerWindow.
 */

import { appPath } from '@/lib/deep-links';
import '@/lib/desktop/types';
import { createComposeHandoff, type ComposeHandoff } from './compose-handoff';
import type { ComposePopoutPayload } from './compose-payload';

const SIZES = {
  message: { width: 960, height: 820 },
  compose: { width: 760, height: 780 },
} as const;

type PopoutKind = keyof typeof SIZES;

/** Offset from the opening window, so the new one doesn't hide it exactly. */
const CASCADE_PX = 48;

export function popoutFeatures(kind: PopoutKind): string {
  const { width, height } = SIZES[kind];
  const left = Math.round((window.screenX || 0) + CASCADE_PX);
  const top = Math.round((window.screenY || 0) + CASCADE_PX);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/** Windows this page opened. window.open with a name would load the address in it again. */
const openedWindows = new Map<string, Window>();

/** Whether a window opened. False when a pop-up blocker said no: the caller stays as it is. */
function openWindow(url: string, name: string, kind: PopoutKind): Window | boolean {
  const bridge = window.bulwarkDesktop?.windows;
  if (bridge?.open) {
    bridge.open(url, { name, ...SIZES[kind] });
    return true;
  }
  const existing = openedWindows.get(name);
  if (existing && !existing.closed) return existing;
  // Not noopener: in an installed app that is what sends a window to the
  // system browser (lib/standalone-display.ts).
  const opened = window.open(url, name, popoutFeatures(kind));
  if (!opened) return false;
  openedWindows.set(name, opened);
  return opened;
}

function focused(opened: Window | boolean): boolean {
  if (opened && typeof opened !== 'boolean') opened.focus?.();
  return !!opened;
}

function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface MessageWindowTarget {
  emailId: string;
  /** The login the message is read through. */
  localAccountId?: string | null;
  /** The JMAP account holding it, for a shared or group folder. */
  ownerAccountId?: string | null;
}

export function messagePopoutUrl(target: MessageWindowTarget): string {
  return appPath(`/popout/message/${encodeURIComponent(target.emailId)}`)
    + query({ account: target.localAccountId, owner: target.ownerAccountId });
}

/** The same message twice focuses the same window, without loading it again. */
export function openMessageWindow(target: MessageWindowTarget): boolean {
  return focused(openWindow(messagePopoutUrl(target), `bulwark-message-${target.emailId.replace(/\W/g, '_')}`, 'message'));
}

export interface ComposerWindow {
  /** Hands the draft over. The pop-out is waiting for it. */
  handOver(payload: ComposePopoutPayload): void;
  /** Calls it off: the pop-out closes. */
  cancel(): void;
}

/**
 * Opens an empty pop-out composer that waits for its draft. Call it straight
 * from the click: a browser only opens a window for a user action. Null when
 * no window opened.
 */
export function openComposerWindow(localAccountId?: string | null): ComposerWindow | null {
  const handoff: ComposeHandoff | null = createComposeHandoff();
  if (!handoff) return null;
  const url = appPath('/popout/compose') + query({ handoff: handoff.id, account: localAccountId });
  const opened = openWindow(url, `bulwark-compose-${handoff.id}`, 'compose');
  if (!focused(opened)) {
    handoff.cancel();
    return null;
  }
  return { handOver: handoff.complete, cancel: handoff.cancel };
}
