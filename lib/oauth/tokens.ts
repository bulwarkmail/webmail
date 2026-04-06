const DEFAULT_SCOPES = 'openid email profile';
const EXTRA_SCOPES = process.env.OAUTH_EXTRA_SCOPES || '';
export const OAUTH_SCOPES = process.env.OAUTH_SCOPES || (EXTRA_SCOPES ? `${DEFAULT_SCOPES} ${EXTRA_SCOPES}`.trim() : DEFAULT_SCOPES);
export const REFRESH_TOKEN_COOKIE = 'jmap_rt';

/** Get the cookie name for a given account slot (0-4). Slot 0 uses the legacy name. */
export function refreshTokenCookieName(slot: number): string {
  return slot === 0 ? REFRESH_TOKEN_COOKIE : `${REFRESH_TOKEN_COOKIE}_${slot}`;
}
