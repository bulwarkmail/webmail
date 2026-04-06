const COOKIE_SAME_SITE = (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'none' | 'strict';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === 'true'
  : (COOKIE_SAME_SITE === 'none' || process.env.NODE_ENV === 'production');

export function getCookieOptions() {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  };
}
