// What one plugin gets of a hook's arguments. The bus hands every handler
// the same value; a part that needs a permission beyond the hook's own is
// cut here, per plugin, before it crosses into the sandbox.

import type { InstalledPlugin, OutgoingEmail } from '../plugin-types';
import { cleanOutgoingKeywords } from '../outgoing/outgoing-keywords';
import { pluginHasPermission } from './permissions';

/** onBeforeEmailSend without the text of attachments, for a plugin that may not read files. */
function withoutTextExcerpts(email: OutgoingEmail): OutgoingEmail {
  if (!Array.isArray(email?.attachments) || !email.attachments.some((a) => a && 'textExcerpt' in a)) return email;
  return {
    ...email,
    attachments: email.attachments.map((attachment) => {
      const { textExcerpt: _omit, ...rest } = attachment;
      void _omit;
      return rest;
    }),
  };
}

export function hookArgsFor(plugin: InstalledPlugin, hookName: string, args: unknown[]): unknown[] {
  if (hookName === 'onBeforeEmailSend' && !pluginHasPermission(plugin, 'email:blob-read') && args[0]) {
    return [withoutTextExcerpts(args[0] as OutgoingEmail), ...args.slice(1)];
  }
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the bus takes of one plugin's answer. onTransformOutgoingEmail hands
 * back the whole message, so what a plugin may not change is put back here:
 * the composer's id always, and the keywords for a plugin without
 * email:write (keywords on the Sent copy are a write to the user's mail).
 * Keywords it may set are checked here, so the author hears about a bad one.
 */
export function hookResultFor(plugin: InstalledPlugin, hookName: string, args: unknown[], result: unknown): unknown {
  if (hookName !== 'onTransformOutgoingEmail' || !isRecord(result) || !isRecord(args[0])) return result;
  const before = args[0] as unknown as OutgoingEmail;
  const next: Record<string, unknown> = { ...result };
  if (before.composerId === undefined) delete next.composerId;
  else next.composerId = before.composerId;
  if (!pluginHasPermission(plugin, 'email:write')) {
    if (before.keywords === undefined) delete next.keywords;
    else next.keywords = [...before.keywords];
    if (result.keywords !== undefined && JSON.stringify(result.keywords) !== JSON.stringify(before.keywords)) {
      console.warn(`[plugin:${plugin.id}] onTransformOutgoingEmail: keywords need the email:write permission; left as they were`);
    }
  } else if (result.keywords !== undefined) {
    next.keywords = cleanOutgoingKeywords(result.keywords, (problem) => console.warn(`[plugin:${plugin.id}] onTransformOutgoingEmail: ${problem}`));
  }
  return next;
}
