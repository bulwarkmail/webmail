// What one plugin gets of a hook's arguments. The bus hands every handler
// the same value; a part that needs a permission beyond the hook's own is
// cut here, per plugin, before it crosses into the sandbox.

import type { InstalledPlugin, OutgoingEmail } from '../plugin-types';
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
