'use client';

import { PluginSlot } from '@/components/plugins/plugin-slot';
import { useAuthStore } from '@/stores/auth-store';
import { XenaxioDomainBanner } from '@/components/xenaxio/domain-banner';
import { XENAXIO_BFF } from '@/lib/xenaxio/bff';

/**
 * Mounts the `app-top-banner` plugin slot with the current session
 * username + serverUrl as extraProps. Drop this at the top of every
 * authenticated page so plugins like impersonation-notice render
 * everywhere, not just on the mail page.
 */
export function AppTopBannerSlot() {
  const username = useAuthStore((s) => s.username);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  return (
    <>
      {/* xenaxio: "domain not connected" notice on every app page. */}
      {XENAXIO_BFF && <XenaxioDomainBanner />}
      <PluginSlot name="app-top-banner" extraProps={{ username, serverUrl }} />
    </>
  );
}
