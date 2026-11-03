/**
 * Opening a message or folder from outside the mail page: a tray item, a toast, a jump
 * list entry. The mail page applies a link the way it applies a permalink. If it isn't
 * on screen, the link waits and the app goes there.
 */

import type { MailDeepLink } from '@/lib/deep-links';

export interface MailLinkOptions {
  replyText?: string;
}

export type MailLinkOpener = (link: MailDeepLink, options?: MailLinkOptions) => void;

let opener: MailLinkOpener | null = null;
let waiting: { link: MailDeepLink; options?: MailLinkOptions } | null = null;

/** The mail page, while it's mounted. Takes over a link that was waiting for it. */
export function setMailLinkOpener(next: MailLinkOpener): () => void {
  opener = next;
  if (waiting) {
    const { link, options } = waiting;
    waiting = null;
    next(link, options);
  }
  return () => {
    if (opener === next) opener = null;
  };
}

export function openMailLink(link: MailDeepLink, options: MailLinkOptions | undefined, leaveFor: (path: '/') => void | Promise<void>): void {
  if (opener) {
    opener(link, options);
    return;
  }
  waiting = { link, options };
  void leaveFor('/');
}

/** For tests. */
export function resetMailLinks(): void {
  opener = null;
  waiting = null;
}
