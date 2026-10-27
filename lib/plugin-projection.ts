// Projection helpers - convert host-internal types into the read-only views
// that plugins consume. Keeping this in one place ensures every slot/hook
// hands plugins the same shape declared in plugin-types.ts.

import type {
  CalendarEvent, CalendarTask, ContactCard, Email, FileNode, Identity, VacationResponse,
} from '@/lib/jmap/types';
import type {
  CalendarEventView, ContactView, EmailReadView, EmailSummary, FileResourceView, IdentityView,
  TaskView, TemplateView, VacationView,
} from '@/lib/plugin-types';
import type { EmailTemplate } from '@/lib/template-types';
import { generateEmailSource } from '@/lib/email-source';
import { isServerSetKeyword } from '@/lib/jmap/server-keywords';

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

/**
 * `accountId` names the JMAP account the message is in; rows of merged views
 * carry it, others only the caller knows (see EmailReadView.accountId).
 */
export function emailToReadView(email: Email, accountId = email.sourceAccountId): EmailReadView {
  return {
    id: email.id,
    ...(accountId ? { accountId } : {}),
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
    attachments: (email.attachments || [])
      .filter((part) => !!part.blobId)
      .map((part) => ({
        blobId: part.blobId as string,
        name: part.name || '',
        type: part.type || 'application/octet-stream',
        size: part.size || 0,
        inline: part.disposition === 'inline' || !!part.cid,
      })),
    preview: email.preview || '',
    text: plainTextFromEmail(email),
    headers: email.headers,
    source: generateEmailSource(email),
    // Stalwart 1.0's attachment keywords are what `hasAttachment` says.
    keywords: Object.keys(email.keywords || {}).filter(k => email.keywords[k] && !isServerSetKeyword(k)),
    auth: email.authenticationResults,
  };
}

const trueKeys = (rec?: Record<string, boolean> | null): string[] =>
  Object.keys(rec || {}).filter((k) => rec?.[k]);

/** Headers and flags of a message, without the body (see EmailSummary). */
export function emailSummary(email: Email, accountId = email.sourceAccountId): EmailSummary {
  return {
    id: email.id,
    ...(accountId ? { accountId } : {}),
    threadId: email.threadId,
    mailboxIds: trueKeys(email.mailboxIds),
    from: (email.from || []).map((a) => ({ name: a.name || '', email: a.email })),
    to: (email.to || []).map((a) => ({ name: a.name || '', email: a.email })),
    subject: email.subject || '',
    receivedAt: email.receivedAt,
    preview: email.preview || '',
    keywords: trueKeys(email.keywords),
    hasAttachment: !!email.hasAttachment,
    size: email.size || 0,
  };
}

export function eventToView(event: CalendarEvent): CalendarEventView {
  const location = Object.values(event.locations || {})[0]?.name || '';
  return {
    id: event.id,
    uid: event.uid,
    calendarId: trueKeys(event.calendarIds)[0] || '',
    title: event.title || '',
    description: event.description || '',
    start: event.start,
    duration: event.duration,
    timeZone: event.timeZone,
    utcStart: event.utcStart,
    utcEnd: event.utcEnd,
    isAllDay: !!event.showWithoutTime,
    location,
    status: event.status,
    participants: Object.values(event.participants || {}).map((p) => ({
      name: p.name || '',
      email: p.email || '',
      role: trueKeys((p as { roles?: Record<string, boolean> }).roles).join(','),
      status: (p as { participationStatus?: string }).participationStatus || '',
    })),
    isRecurring: !!(event.recurrenceRules && event.recurrenceRules.length > 0),
    keywords: trueKeys(event.keywords),
  };
}

function anniversaryDate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as { year?: number; month?: number; day?: number; utc?: string };
    if (typeof v.utc === 'string') return v.utc.slice(0, 10);
    const mm = String(v.month ?? 0).padStart(2, '0');
    const dd = String(v.day ?? 0).padStart(2, '0');
    return v.year ? `${String(v.year).padStart(4, '0')}-${mm}-${dd}` : `--${mm}-${dd}`;
  }
  return '';
}

export function contactToView(contact: ContactCard): ContactView {
  const components = contact.name?.components || [];
  const part = (kind: string) => components.filter((c) => c.kind === kind).map((c) => c.value).join(' ');
  return {
    id: contact.id,
    uid: contact.uid || '',
    addressBookId: trueKeys(contact.addressBookIds)[0] || '',
    kind: contact.kind || 'individual',
    fullName: contact.name?.full || [part('given'), part('surname')].filter(Boolean).join(' '),
    firstName: part('given'),
    lastName: part('surname'),
    emails: Object.values(contact.emails || {}).map((e) => e.address).filter(Boolean),
    phones: Object.values(contact.phones || {}).map((p) => p.number).filter(Boolean),
    company: Object.values(contact.organizations || {})[0]?.name || '',
    notes: Object.values(contact.notes || {}).map((n) => (n as { note?: string }).note || '').join('\n'),
    anniversaries: Object.values(contact.anniversaries || {}).map((a) => ({ kind: a.kind, date: anniversaryDate(a.date) })),
  };
}

export function taskToView(task: CalendarTask): TaskView {
  return {
    id: task.id,
    uid: task.uid,
    title: task.title || '',
    description: task.description || '',
    isComplete: task.progress === 'completed',
    progress: task.progress,
    dueDate: task.due,
    priority: task.priority ?? 0,
    calendarId: trueKeys(task.calendarIds)[0] || '',
    keywords: trueKeys(task.keywords),
  };
}

export function fileToView(node: FileNode, path = ''): FileResourceView {
  const isDir = node.type === 'd' || node.blobId === null;
  return {
    id: node.id,
    name: node.name,
    type: isDir ? 'directory' : 'file',
    size: node.size || 0,
    mimeType: isDir ? '' : node.type,
    path,
    modified: node.modified,
  };
}

export function identityToView(identity: Identity): IdentityView {
  return {
    id: identity.id,
    name: identity.name || '',
    email: identity.email,
    replyTo: identity.replyTo?.map((a) => a.email).join(', ') || null,
    bcc: identity.bcc?.map((a) => a.email).join(', ') || null,
    htmlSignature: identity.htmlSignature || '',
    textSignature: identity.textSignature || '',
  };
}

export function templateToView(template: EmailTemplate): TemplateView {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    subject: template.subject || '',
    body: template.body || '',
    isHTML: !!template.isHTML,
  };
}

export function vacationToView(vacation: VacationResponse): VacationView {
  return {
    isEnabled: vacation.isEnabled,
    subject: vacation.subject || '',
    htmlBody: vacation.htmlBody || '',
    textBody: vacation.textBody || '',
    fromDate: vacation.fromDate,
    toDate: vacation.toDate,
  };
}
