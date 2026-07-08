// Projection helpers - convert host-internal types into the read-only views
// that plugins consume. Keeping this in one place ensures every slot/hook
// hands plugins the same shape declared in plugin-types.ts.

import type { Email } from '@/lib/jmap/types';
import type { EmailReadView } from '@/lib/plugin-types';
import { generateEmailSource } from '@/lib/email-source';

// Resolve a message's plain-text body from its JMAP body parts. Plugins that
// translate or scan content need the real body, not just the short `preview`
// snippet. Prefers text/plain parts; falls back to stripped HTML, then preview.
function plainTextFromEmail(email: Email): string {
  const values = email.bodyValues || {};
  const collect = (parts?: { partId: string }[]) =>
    (parts || [])
      .map((p) => values[p.partId]?.value)
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\n')
      .trim();

  const text = collect(email.textBody);
  if (text) return text;

  const html = collect(email.htmlBody);
  if (html) {
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return (email.preview || '').trim();
}

export function emailToReadView(email: Email): EmailReadView {
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds: Object.keys(email.mailboxIds || {}).filter(k => email.mailboxIds[k]),
    from: (email.from || []).map(a => ({ name: a.name || '', email: a.email })),
    to: (email.to || []).map(a => ({ name: a.name || '', email: a.email })),
    cc: (email.cc || []).map(a => ({ name: a.name || '', email: a.email })),
    subject: email.subject || '',
    receivedAt: email.receivedAt,
    isRead: !!email.keywords?.['$seen'],
    isFlagged: !!email.keywords?.['$flagged'],
    hasAttachment: email.hasAttachment,
    preview: email.preview || '',
    text: plainTextFromEmail(email),
    headers: email.headers,
    source: generateEmailSource(email),
    keywords: Object.keys(email.keywords || {}).filter(k => email.keywords[k]),
    auth: email.authenticationResults,
  };
}
