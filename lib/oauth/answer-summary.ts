/**
 * What of a provider's token endpoint answer may go into a log: the OAuth
 * `error` code of an error answer and the names of the fields of any other.
 * Never a value: a token answer holds tokens even when it lacks the one
 * expected, and an error body can repeat what was sent.
 */

/** The `error` code of an OAuth error answer (RFC 6749 section 5.2), or null. */
export function oauthErrorCode(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** The field names of a parsed token answer. */
export function answerFields(answer: unknown): string[] {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  return Object.keys(answer).slice(0, 20).map((key) => key.slice(0, 64));
}
