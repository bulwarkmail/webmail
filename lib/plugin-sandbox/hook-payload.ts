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
 * Whether `url` is on an origin of the plugin's httpOrigins, by the rules
 * api.http.fetch uses (host-api.ts): https only, the same port, and
 * `https://*.example.org` for exactly one more label.
 */
function originInHttpOrigins(url: URL, httpOrigins: readonly string[]): boolean {
  if (url.protocol !== 'https:') return false;
  for (const entry of httpOrigins) {
    let parsed: URL;
    try { parsed = new URL(entry.replace('*.', '')); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    if ((url.port || '') !== (parsed.port || '')) continue;
    if (entry.includes('*.')) {
      const suffix = '.' + parsed.hostname.toLowerCase();
      const host = url.hostname.toLowerCase();
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, host.length - suffix.length);
        if (prefix.length > 0 && !prefix.includes('.')) return true;
      }
    } else if (url.hostname.toLowerCase() === parsed.hostname.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * An avatar address becomes the src of an <img> in the host page, which may
 * load from any https host. So a plugin's answer is kept only when it is a
 * picture the plugin made (a data: image or a blob:), or an address on a
 * host the plugin declared in httpOrigins while it holds http:fetch: the
 * consent dialog shows those hosts as what that permission reaches, and
 * only then. Anything else counts as no answer. Where the browser goes
 * after that host (a redirect) is the host's choice. What is handed on is
 * the address as it was tested, without white space around it.
 */
function avatarAnswerFor(plugin: InstalledPlugin, result: unknown): unknown {
  if (result === undefined || result === null || result === false) return result;
  if (typeof result !== 'string') return undefined;
  const value = result.trim();
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value) || /^blob:/i.test(value)) return value;
  if (!pluginHasPermission(plugin, 'http:fetch')) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  return originInHttpOrigins(url, plugin.httpOrigins ?? []) ? value : undefined;
}

/**
 * What the bus takes of one plugin's answer. onTransformOutgoingEmail hands
 * back the whole message, so what a plugin may not change is put back here:
 * the composer's id always, and the keywords for a plugin without
 * email:write (keywords on the Sent copy are a write to the user's mail).
 * Keywords it may set are checked here, so the author hears about a bad one.
 * onAvatarResolve answers are held to the plugin's own hosts (above).
 */
export function hookResultFor(plugin: InstalledPlugin, hookName: string, args: unknown[], result: unknown): unknown {
  if (hookName === 'onAvatarResolve') return avatarAnswerFor(plugin, result);
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
