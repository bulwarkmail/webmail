/**
 * Sub-addressing utilities for user{delimiter}tag@domain.com format
 * Works server-side automatically - no JMAP API calls needed
 *
 * The delimiter character is configurable per server (RFC 5233). Common
 * choices: "+" (Postfix, Stalwart default), "-" (qmail), ".", "=".
 */

// Constants for tag validation
const MAX_TAG_LENGTH = 30;
const TAG_REGEX = /^[a-zA-Z0-9-]{1,30}$/;

export const DEFAULT_SUB_ADDRESS_DELIMITER = '+';
export const SUPPORTED_SUB_ADDRESS_DELIMITERS = ['+', '-', '.', '='] as const;
export type SubAddressDelimiter = (typeof SUPPORTED_SUB_ADDRESS_DELIMITERS)[number];

export function isSupportedSubAddressDelimiter(value: string): value is SubAddressDelimiter {
  return (SUPPORTED_SUB_ADDRESS_DELIMITERS as readonly string[]).includes(value);
}

export type TagValidationErrorCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'INVALID_CHARS'
  | null;

export interface ParsedAddress {
  localPart: string;
  baseUser: string;
  tag: string | null;
  domain: string;
  fullAddress: string;
}

/**
 * Parse an email address to extract sub-address tag.
 * The first occurrence of the delimiter in the local part separates the
 * base user from the tag, matching the behavior of Postfix/qmail/Sieve.
 */
export function parseSubAddress(
  email: string,
  delimiter: string = DEFAULT_SUB_ADDRESS_DELIMITER,
): ParsedAddress {
  const [localPart, domain] = email.split('@');

  if (!localPart || !domain) {
    return {
      localPart: localPart || '',
      baseUser: localPart || '',
      tag: null,
      domain: domain || '',
      fullAddress: email,
    };
  }

  const delimiterIndex = localPart.indexOf(delimiter);

  if (delimiterIndex === -1) {
    return {
      localPart,
      baseUser: localPart,
      tag: null,
      domain,
      fullAddress: email,
    };
  }

  const baseUser = localPart.substring(0, delimiterIndex);
  const tag = localPart.substring(delimiterIndex + delimiter.length);

  return {
    localPart,
    baseUser,
    tag: tag || null,
    domain,
    fullAddress: email,
  };
}

/**
 * Generate a sub-addressed email.
 * Example: generateSubAddress("user@example.com", "shopping", "+") -> "user+shopping@example.com"
 */
export function generateSubAddress(
  baseEmail: string,
  tag: string,
  delimiter: string = DEFAULT_SUB_ADDRESS_DELIMITER,
): string {
  const [localPart, domain] = baseEmail.split('@');

  if (!localPart || !domain || !tag) {
    return baseEmail;
  }

  // Strip an existing tag if one is already present
  const existingDelimiterIndex = localPart.indexOf(delimiter);
  const cleanLocal = existingDelimiterIndex === -1
    ? localPart
    : localPart.substring(0, existingDelimiterIndex);

  // Sanitize tag (alphanumeric and dash only)
  const cleanTag = tag.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();

  if (!cleanTag) {
    return baseEmail;
  }

  return `${cleanLocal}${delimiter}${cleanTag}@${domain}`;
}

/**
 * Extract domain from recipient email for tag suggestions
 */
export function extractDomain(email: string): string | null {
  const match = email.match(/@([^@]+)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Suggest tags based on recipient domain
 */
export function suggestTagsForDomain(domain: string): string[] {
  const domainLower = domain.toLowerCase();

  // Common domain-based suggestions
  const suggestions: Record<string, string[]> = {
    'amazon.com': ['amazon', 'shopping', 'orders'],
    'amazon.fr': ['amazon', 'shopping', 'orders'],
    'amazon.de': ['amazon', 'shopping', 'orders'],
    'amazon.co.uk': ['amazon', 'shopping', 'orders'],
    'ebay.com': ['ebay', 'shopping'],
    'ebay.fr': ['ebay', 'shopping'],
    'paypal.com': ['paypal', 'payments'],
    'facebook.com': ['facebook', 'social'],
    'twitter.com': ['twitter', 'social'],
    'x.com': ['twitter', 'social'],
    'linkedin.com': ['linkedin', 'professional'],
    'github.com': ['github', 'dev', 'notifications'],
    'gitlab.com': ['gitlab', 'dev', 'notifications'],
    'stackoverflow.com': ['stackoverflow', 'dev'],
    'reddit.com': ['reddit', 'social'],
    'netflix.com': ['netflix', 'entertainment'],
    'spotify.com': ['spotify', 'music'],
    'steam.com': ['steam', 'gaming'],
    'discord.com': ['discord', 'gaming'],
  };

  // Check for exact domain match
  if (suggestions[domainLower]) {
    return suggestions[domainLower];
  }

  // Extract main domain (e.g., "mail.google.com" -> "google")
  const parts = domainLower.split('.');
  const mainDomain = parts.length >= 2 ? parts[parts.length - 2] : parts[0];

  // Generic suggestions based on domain name
  return [mainDomain, 'newsletter', 'registration'];
}

/**
 * Validate if a tag is safe to use
 */
export function isValidTag(tag: string): boolean {
  return TAG_REGEX.test(tag);
}

/**
 * Get validation error code for an invalid tag
 * Returns an error code that should be translated by the calling component
 */
export function getTagValidationError(tag: string): TagValidationErrorCode {
  if (!tag) {
    return 'EMPTY';
  }

  if (tag.length > MAX_TAG_LENGTH) {
    return 'TOO_LONG';
  }

  if (!/^[a-zA-Z0-9-]+$/.test(tag)) {
    return 'INVALID_CHARS';
  }

  return null;
}

// Export MAX_TAG_LENGTH for use in translations
export { MAX_TAG_LENGTH };
