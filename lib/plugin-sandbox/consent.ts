// Queue for plugin permission-consent requests.
//
// On first enable the plugin store posts a ConsentRequest here; the
// `PluginConsentDialog` component renders the head and resolves the promise
// when the user accepts or rejects. The store persists the granted set in
// `plugin.grantedPermissions` so future enables don't re-prompt.

import type { Permission } from '../plugin-types';

export interface ConsentRequest {
  id: string;
  pluginId: string;
  pluginName: string;
  permissions: Permission[];
  resolve: (granted: boolean) => void;
}

const queue: ConsentRequest[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function requestConsent(pluginId: string, pluginName: string, permissions: Permission[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ id: uid(), pluginId, pluginName, permissions, resolve });
    notify();
  });
}

export function head(): ConsentRequest | null {
  return queue[0] ?? null;
}

export function resolveHead(granted: boolean): void {
  const entry = queue.shift();
  if (!entry) return;
  try { entry.resolve(granted); } catch { /* ignore */ }
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ─── Friendly labels for permission strings ───────────────────

const PERMISSION_LABELS: Record<string, { title: string; body: string }> = {
  'email:read':       { title: 'Read your email',                body: 'Access subjects, senders, recipients, body previews, and message bodies of your messages.' },
  'email:write':      { title: 'Modify your email',              body: 'Move, delete, flag, archive, or change keywords on your messages.' },
  'email:send':       { title: 'Send mail and transform drafts', body: 'Compose and send messages, and modify content right before delivery.' },
  'crypto:full':      { title: 'Full cryptographic access (high risk)', body: 'Runs with full cryptographic access in a privileged, same-origin context. It can read your message bodies and private keys, store key material, and sign/encrypt on your behalf. Only enable plugins you fully trust — this is comparable to a full-access browser extension.' },
  'email:raw-send':   { title: 'Send raw messages',                body: 'Submit fully-formed (e.g. signed or encrypted) messages on your behalf.' },
  'email:blob-read':  { title: 'Read raw message content',        body: 'Fetch the raw bytes of your messages and attachments (needed to decrypt and verify them).' },
  'email:blob-write':  { title: 'Alterate raw message content',        body: 'get the raw file content before it is uploaded to alterate it just before is is sended to server. (needed to encrypt)' },
  'email:render-takeover': { title: 'Replace rendered email content', body: 'Replace the displayed content of an opened message (e.g. to show decrypted text and a signature-verification badge).' },
  'calendar:read':    { title: 'Read your calendar',             body: 'Access events, calendars, RSVPs, and reminders.' },
  'calendar:write':   { title: 'Modify your calendar',           body: 'Create, edit, or delete events.' },
  'contacts:read':    { title: 'Read your contacts',             body: 'Access your address book entries.' },
  'contacts:write':   { title: 'Modify your contacts',           body: 'Create, edit, or delete contact entries.' },
  'files:read':       { title: 'Read your files',                body: 'Browse files stored in your WebDAV folders.' },
  'files:write':      { title: 'Modify your files',              body: 'Create, edit, rename, move, or delete files.' },
  'identity:read':    { title: 'Read your identities',           body: 'Access the From addresses and signatures you send mail from.' },
  'identity:write':   { title: 'Modify your identities',         body: 'Create, edit, or delete identities.' },
  'filters:read':     { title: 'Read your filters',              body: 'Access your Sieve mail-filter rules.' },
  'filters:write':    { title: 'Modify your filters',            body: 'Create, edit, or delete Sieve filter rules.' },
  'tasks:read':       { title: 'Read your tasks',                body: 'Access your task list.' },
  'tasks:write':      { title: 'Modify your tasks',              body: 'Create, edit, or delete tasks.' },
  'templates:read':   { title: 'Read your templates',            body: 'Access stored mail templates.' },
  'templates:write':  { title: 'Modify your templates',          body: 'Create, edit, or delete mail templates.' },
  'smime:read':       { title: 'Read your S/MIME state',         body: 'Access information about installed S/MIME keys and certificates.' },
  'vacation:read':    { title: 'Read your vacation auto-reply',  body: 'See the configured vacation auto-reply state.' },
  'vacation:write':   { title: 'Modify your vacation auto-reply',body: 'Create, change, or remove the vacation auto-reply.' },
  'settings:read':    { title: 'Read your settings',             body: 'Access non-secret user preferences.' },
  'settings:write':   { title: 'Modify your settings',           body: 'Change non-secret user preferences.' },
  'security:read':    { title: 'Read account security state',    body: 'See whether TOTP / encryption are enabled (no secrets exposed).' },
  'auth:observe':     { title: 'Observe login events',           body: 'See when you log in, log out, or switch accounts.' },
  'http:post':        { title: 'Call same-origin APIs',          body: 'Make authenticated requests to the webmail backend on your behalf.' },
  'http:fetch':       { title: 'Talk to external services',      body: 'Make uncredentialled requests to the third-party origins listed in the manifest.' },
  'admin:config':     { title: 'Read/write admin config',        body: 'Access this plugin\'s admin-supplied configuration values.' },
  'ui:download-file': { title: 'Download files',                 body: 'Download custom files generated by the plugin.' },
};

export function describePermission(perm: string): { title: string; body: string } {
  return PERMISSION_LABELS[perm] ?? { title: perm, body: 'No description available.' };
}
