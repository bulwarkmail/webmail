/**
 * RFC 5322 compliant email validation with security enhancements
 */
export function isValidEmail(email: string): boolean {
  // Length check
  if (!email || email.length > 254) return false;

  // Security: Block control characters and header injection
  if (/[\r\n\0<>]/.test(email)) return false;

  // RFC 5322 compliant regex (simplified but secure)
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  if (!emailRegex.test(email)) return false;

  // Additional checks
  const [localPart, domain] = email.split('@');

  // Local part max 64 chars
  if (localPart.length > 64) return false;

  // Domain validation
  if (domain.length > 255) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;

  return true;
}

/**
 * Validate comma-separated email list
 * @returns Object with validation result and invalid emails
 */
export function validateEmailList(csv: string): {
  valid: boolean;
  invalidEmails: string[];
} {
  if (!csv?.trim()) {
    return { valid: true, invalidEmails: [] };
  }

  const emails = csv.split(',').map(e => e.trim()).filter(Boolean);
  const invalid = emails.filter(e => !isValidEmail(e));

  return {
    valid: invalid.length === 0,
    invalidEmails: invalid
  };
}

/**
 * Get user-friendly validation error message
 */
export function getEmailValidationError(email: string): string | null {
  if (!email?.trim()) return 'Email address is required';

  if (email.length > 254) return 'Email address is too long (max 254 characters)';

  if (/[\r\n\0<>]/.test(email)) {
    return 'Email address contains invalid characters';
  }

  if (!isValidEmail(email)) {
    return 'Please enter a valid email address';
  }

  return null;
}

/**
 * Validate unsubscribe URL (RFC 2369 List-Unsubscribe)
 * Only allows safe protocols: http, https, mailto
 * @param url - URL to validate
 * @returns true if URL is safe to use
 */
export function isValidUnsubscribeUrl(url: string): boolean {
  if (!url?.trim()) return false;

  if (url.startsWith('mailto:')) {
    const email = url.substring(7);
    const emailPart = email.split('?')[0];
    return isValidEmail(emailPart);
  }

  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Parse List-Unsubscribe header and extract all valid URLs
 * RFC 2369 allows multiple comma-separated URLs in <url> format
 * @param header - Raw List-Unsubscribe header value
 * @returns Object with http and mailto URLs, plus preferred method
 */
export function parseUnsubscribeUrls(header: string): {
  http?: string;
  mailto?: string;
  preferred?: 'http' | 'mailto';
} {
  if (!header?.trim()) return {};

  const matches = header.match(/<([^>]+)>/g);
  if (!matches) return {};

  const urls = matches.map(m => m.slice(1, -1).trim());

  const http = urls.find(u =>
    (u.startsWith('http://') || u.startsWith('https://')) &&
    isValidUnsubscribeUrl(u)
  );
  const mailto = urls.find(u =>
    u.startsWith('mailto:') &&
    isValidUnsubscribeUrl(u)
  );

  const preferred = http ? 'http' : (mailto ? 'mailto' : undefined);

  return { http, mailto, preferred };
}

/**
 * Parse a mailto: URL into its parts so the client can send the message
 * itself. Query values are percent-decoded manually rather than via
 * URLSearchParams because RFC 6068 uses %-encoding only - a literal "+"
 * in a subject or address must stay a plus, not become a space.
 * @param url - mailto: URL, e.g. "mailto:a@b.c?subject=Unsubscribe%20123"
 * @returns Recipients plus optional subject/body, or null without a valid recipient
 */
export function parseMailtoUrl(url: string): { to: string[]; subject?: string; body?: string } | null {
  if (!url?.startsWith('mailto:')) return null;

  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const to = addressPart
    .split(',')
    .map(a => decode(a).trim())
    .filter(a => isValidEmail(a));

  let subject: string | undefined;
  let body: string | undefined;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (key === 'subject') subject = value;
    else if (key === 'body') body = value;
    else if (key === 'to' && isValidEmail(value.trim())) to.push(value.trim());
  }

  return to.length > 0 ? { to, subject, body } : null;
}
