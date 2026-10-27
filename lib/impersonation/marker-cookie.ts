/**
 * Set by the impersonate route next to its `/?impersonated=1` redirect, so the
 * client only wipes its account list after a real handoff, not for anyone
 * who links to that URL. Readable by scripts and short-lived on purpose.
 */
export const IMPERSONATION_MARKER_COOKIE = 'jmap_impersonated';
export const IMPERSONATION_MARKER_MAX_AGE_SECONDS = 60;
