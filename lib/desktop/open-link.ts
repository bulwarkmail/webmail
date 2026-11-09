/**
 * "Open Link" in the desktop app's native menu. It has to go where a click on the
 * link goes: a mail address to the app's composer, anything else past
 * resolveExternalLink, where a plugin can stop it or send it elsewhere.
 */

import { isOpenableLinkHref } from '@/lib/email-sanitization';
import { resolveExternalLink } from '@/lib/plugin-hook-result';
import { requestInternalMailto } from '@/lib/protocol-handlers/mailto';
import { getDesktopBridge } from './bridge';

export async function openLinkFromNativeMenu(href: string, text: string, emailId?: string): Promise<void> {
  const shell = getDesktopBridge()?.shell;
  if (!shell) return;
  if (/^mailto:/i.test(href)) {
    if (!requestInternalMailto(href)) shell.openExternal(href);
    return;
  }
  if (!isOpenableLinkHref(href)) return;
  const target = await resolveExternalLink({ href, target: '_blank', emailId, text });
  if (target) shell.openExternal(target);
}
