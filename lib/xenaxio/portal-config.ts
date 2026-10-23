// Step 17: the company's logo replaces the product logo of config.json in the
// mail app (sidebar, top bar). Kept apart from use-config.ts so the upstream
// file changes by one line only.
import type { ConfigData } from "@/hooks/use-config";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { portalLogo } from "@/lib/xenaxio/portal";

type ProductLogo = { light: string; dark: string };

// The config.json logos before the company's logo replaced them. The About
// card ("xenaxio vX.Y") names the product, so it keeps the product's mark.
let productLogo: ProductLogo | null = null;

export async function withPortalLogo(config: ConfigData): Promise<ConfigData> {
  if (!XENAXIO_BFF) return config;
  productLogo = { light: config.appLogoLightUrl, dark: config.appLogoDarkUrl };
  const logo = await portalLogo().catch(() => null);
  return logo ? { ...config, appLogoLightUrl: logo, appLogoDarkUrl: logo } : config;
}

/** The product's own logos from config.json; null until the config is loaded. */
export function productLogoUrls(): ProductLogo | null {
  return productLogo;
}
