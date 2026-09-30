/**
 * Scopes requested when neither OAUTH_SCOPES nor an admin override is set.
 * Kept free of server imports so the login page and admin dashboard can show
 * the same list the server actually sends.
 */
export const DEFAULT_OAUTH_SCOPES = 'openid email profile';
