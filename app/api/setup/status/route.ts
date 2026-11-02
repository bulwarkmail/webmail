import { NextResponse } from 'next/server';
import { detectSetupState } from '@/lib/setup/state';
import { authenticateWizardRequest, setupStoreUnavailableResponse } from '@/lib/setup/session';
import { isStoreUnavailableError } from '@/lib/shared-store';
import { configManager } from '@/lib/admin/config-manager';
import { isConfigReadOnly } from '@/lib/admin/paths';
import { SENSITIVE_CONFIG_KEYS } from '@/lib/admin/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/setup/status - public endpoint that returns the wizard state
 * and (if authenticated) the partial config saved by previous steps. The
 * wizard polls this on load so a refresh resumes with prior values.
 *
 * Sensitive values (OAuth client secret, session secret) are NEVER sent
 * back to the client - only a `<key>HasValue` boolean. Re-entering them
 * after refresh is the price of not exposing them.
 */
export async function GET() {
  await configManager.ensureLoaded();
  const state = detectSetupState();
  let authenticated = false;
  try {
    authenticated = state === 'bootstrap' ? await authenticateWizardRequest() : false;
  } catch (error) {
    if (isStoreUnavailableError(error)) return setupStoreUnavailableResponse();
    throw error;
  }

  let partialConfig: Record<string, unknown> | null = null;
  if (state === 'bootstrap' && authenticated) {
    // Only echo back values the operator has actually saved during the
    // wizard (admin overrides). System defaults must not flow back here,
    // because the wizard has its own opinionated defaults (e.g. settings
    // sync on by default) that we'd otherwise stomp.
    const sources = configManager.getAllWithSources();
    const safe: Record<string, unknown> = {};
    for (const [key, info] of Object.entries(sources)) {
      if (info.source !== 'admin') continue;
      if (SENSITIVE_CONFIG_KEYS.has(key)) {
        safe[`${key}HasValue`] = typeof info.value === 'string' && info.value.length > 0;
      } else {
        safe[key] = info.value;
      }
    }
    partialConfig = safe;
  }

  return NextResponse.json(
    {
      state,
      authenticated,
      readOnly: isConfigReadOnly(),
      partialConfig,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
