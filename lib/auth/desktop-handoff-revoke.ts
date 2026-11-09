import { logger } from '@/lib/logger';
import type { ParkedHandoff } from '@/lib/auth/handoff-store';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { buildOAuthParams, DEFAULT_CLIENT_ID, getDiscoveryValidator, getRequiredConfig } from '@/lib/oauth/token-exchange';

const REVOCATION_TIMEOUT_MS = 3000;

/**
 * A refresh token that was minted and then not wanted: declined, or refused by the device's
 * policy. Revoked where the provider has an endpoint for it (Stalwart has none, and there the
 * token just stops being held). Never throws: nobody is waiting to hear about a failure.
 */
export async function revokeParkedTokens(parked: ParkedHandoff): Promise<void> {
  if (parked.flow !== 'desktop-tokens' || !parked.refresh_token) return;
  try {
    const options = { fallbackClientId: DEFAULT_CLIENT_ID };
    const { discoveryUrl } = getRequiredConfig(parked.server_id, options);
    const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });
    if (!metadata?.revocation_endpoint) return;
    const params = buildOAuthParams({ token: parked.refresh_token, token_type_hint: 'refresh_token' }, parked.server_id, options);
    // The body holds the refresh token: no redirect is followed with it.
    const response = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) logger.warn('Declined token revocation returned error', { status: response.status });
  } catch (error) {
    logger.warn('Declined token revocation failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
