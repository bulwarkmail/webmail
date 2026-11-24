import { useMemo } from 'react';
import { usePolicyStore } from '@/stores/policy-store';
import { IS_LITE } from '@/lib/lite';
import { withBasePath } from '@/lib/browser-navigation';
import { remoteContentProxyBase } from '@/lib/remote-content-proxy';

/**
 * Where remote pictures of a message load from when the user allows them:
 * this server's /api/remote-content folder while the admin policy's
 * `remoteContentProxyEnabled` gate is on (#1021), null for straight from the
 * sender. Lite has no server, so never there. Only an explicit `true` counts:
 * a policy from before the gate existed loads as before.
 */
export function useRemoteContentProxyBase(): string | null {
  const on = usePolicyStore((s) => s.policy.features?.remoteContentProxyEnabled === true);
  return useMemo(() => {
    if (!on || IS_LITE || typeof window === 'undefined') return null;
    return remoteContentProxyBase(window.location.origin, withBasePath('/'));
  }, [on]);
}
