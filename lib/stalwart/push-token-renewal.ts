import type { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { isPastMaxAge, maxSessionHoursFor, tokenSignedInAt } from '@/lib/auth/session-age';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { redeemRefreshToken, storeRenewedTokens, wasSignedOut } from '@/lib/oauth/slot-renewal';
import {
  accessTokenCookieName,
  decodeCachedAccessToken,
  refreshTokenCookieName,
  refreshTokenServerCookieName,
} from '@/lib/oauth/tokens';
import type { StalwartAuthContext } from '@/lib/stalwart/auth-context';
import { limitsOnlyAPageEnforces } from '@/lib/stalwart/push-auth-context';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * A working Authorization header for a push preview whose token sign-in the
 * mail server just turned away (#1509). The auth context keeps the access
 * token the page last handed it; with no tab open to renew it, it expires
 * within the hour and every push after that would end in the worker's
 * generic notification.
 *
 * Takes the token a page renewed since, when the cache still holds one, and
 * otherwise renews with the slot's refresh token as the token route would,
 * writing the rotated token back for the page to find. Null when the slot
 * can't be renewed from here:
 * - not a token sign-in, or no refresh token
 * - the sign-in is past the maximum session length, or limits apply that
 *   only a page enforces (the page signs out, this must not keep it going)
 * - the stamp doesn't say whether the sign-in was remembered, which decides
 *   how long the rotated refresh token is kept (the page's next renewal
 *   records it)
 * - the provider refused or is out of reach
 */
export async function renewPushAuthHeader(
  cookieStore: CookieStore,
  slot: number,
  context: StalwartAuthContext,
  basePath: string | undefined,
): Promise<string | null> {
  if (!/^Bearer\s/i.test(context.authHeader)) return null;
  // The desktop app's sign-ins go to servers it registered with itself.
  if (IS_DESKTOP_BUILD) return null;

  const cached = decodeCachedAccessToken(cookieStore.get(accessTokenCookieName(slot))?.value);
  if (cached && `Bearer ${cached.accessToken}` !== context.authHeader) return `Bearer ${cached.accessToken}`;

  const refreshToken = cookieStore.get(refreshTokenCookieName(slot))?.value;
  if (!refreshToken) return null;
  const age = await tokenSignedInAt(cookieStore, slot, refreshToken);
  const remember = age?.stamp?.remember;
  if (!age || remember === undefined) return null;
  const maxHours = await maxSessionHoursFor(age.stamp?.account ?? context.accountName ?? context.username);
  if (isPastMaxAge(age.signedInAt, maxHours)) return null;
  if (await limitsOnlyAPageEnforces()) return null;

  const serverId = cookieStore.get(refreshTokenServerCookieName(slot))?.value || null;
  const redemption = await redeemRefreshToken(refreshToken, serverId, null);
  if (redemption.kind !== 'issued' || !redemption.tokens.access_token) {
    // The page's own renewal clears the cookies of a refused grant.
    logger.warn('push preview: token renewal failed', {
      slot,
      ...(redemption.kind === 'refused' ? { status: redemption.status } : {}),
      ...(redemption.kind === 'unreachable' ? { error: redemption.message } : {}),
    });
    return null;
  }
  // Signed out while the provider answered: writing the rotated token back
  // would undo the sign-out. Per process, like the redemption it waited on.
  // A sign-out that reaches another replica, or that the browser applies
  // before an answer this route already sent, is not covered.
  if (wasSignedOut(refreshToken)) return null;
  const { accessToken } = storeRenewedTokens(
    cookieStore,
    slot,
    { ...redemption.tokens, access_token: redemption.tokens.access_token },
    { remember, age, basePath },
  );
  return `Bearer ${accessToken}`;
}
