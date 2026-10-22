// Step 17: the company's logo replaces the product logo of config.json in the
// mail app (sidebar, top bar). Kept apart from use-config.ts so the upstream
// file changes by one line only.
import type { ConfigData } from "@/hooks/use-config";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { portalLogo } from "@/lib/xenaxio/portal";

export async function withPortalLogo(config: ConfigData): Promise<ConfigData> {
  if (!XENAXIO_BFF) return config;
  const logo = await portalLogo().catch(() => null);
  return logo ? { ...config, appLogoLightUrl: logo, appLogoDarkUrl: logo } : config;
}
