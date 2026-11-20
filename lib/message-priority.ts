/**
 * Message priority set in the composer (#970).
 *
 * Clients disagree on which header carries it: Outlook reads Importance
 * (RFC 4021), Thunderbird and most others read the de-facto X-Priority
 * (1 highest ... 5 lowest). Both are written so the hint survives either
 * way. Priority (RFC 4021, MIXER) is left out: it is meant to steer
 * transmission, not display. Normal writes nothing, so ordinary mail is
 * unchanged.
 */
export type MessagePriority = 'high' | 'normal' | 'low';

/** JMAP Email/set create properties (RFC 8621 §4.1.3) for a priority. */
export function messagePriorityHeaders(priority: MessagePriority | undefined): Record<string, string> {
  if (priority === 'high') {
    return {
      'header:X-Priority:asText': '1 (Highest)',
      'header:Importance:asText': 'high',
    };
  }
  if (priority === 'low') {
    return {
      'header:X-Priority:asText': '5 (Lowest)',
      'header:Importance:asText': 'low',
    };
  }
  return {};
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim()) return first.trim();
  }
  return undefined;
}

/**
 * The priority a message's headers carry, for restoring a re-opened draft.
 * X-Priority wins over Importance; 1-2 is high, 4-5 low, anything else normal.
 */
export function messagePriorityFromHeaders(headers: Record<string, string | string[]> | undefined | null): MessagePriority {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return 'normal';
  const xPriority = headerValue(headers, 'X-Priority');
  const level = xPriority ? Number.parseInt(xPriority, 10) : NaN;
  if (level === 1 || level === 2) return 'high';
  if (level === 4 || level === 5) return 'low';
  if (!Number.isNaN(level)) return 'normal';
  const importance = headerValue(headers, 'Importance')?.toLowerCase();
  if (importance === 'high') return 'high';
  if (importance === 'low') return 'low';
  return 'normal';
}

/**
 * The two headers a list fetch asks for so rows can show a received
 * message's priority (#1809). Stalwart answers header properties from the
 * stored headers, not the message blob.
 */
export const LIST_PRIORITY_PROPERTIES = ['header:X-Priority:asText', 'header:Importance:asText'] as const;

/**
 * Turns the list properties above on an Email/get row into `priority` (set
 * only when high or low) and drops the raw properties.
 */
export function applyListPriority(record: Record<string, unknown>): void {
  const headers: Record<string, string> = {};
  const xPriority = record['header:X-Priority:asText'];
  const importance = record['header:Importance:asText'];
  if (typeof xPriority === 'string') headers['X-Priority'] = xPriority;
  if (typeof importance === 'string') headers.Importance = importance;
  delete record['header:X-Priority:asText'];
  delete record['header:Importance:asText'];
  const priority = messagePriorityFromHeaders(headers);
  if (priority !== 'normal') record.priority = priority;
}

/**
 * A received message's priority: from its full headers once the message is
 * open, else from what the list fetch found.
 */
export function emailPriority(email: { headers?: Record<string, string | string[]>; priority?: 'high' | 'low' }): MessagePriority {
  if (email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers)) {
    return messagePriorityFromHeaders(email.headers);
  }
  return email.priority ?? 'normal';
}
