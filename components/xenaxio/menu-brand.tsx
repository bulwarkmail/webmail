"use client";

// The company's logo at the top of the folder menu on phone and tablet. There
// the side rail and top bar that carry it on a computer are hidden.
import { useConfig } from "@/hooks/use-config";
import { useThemeStore } from "@/stores/theme-store";
import { withBasePath } from "@/lib/browser-navigation";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

export function MenuBrand() {
  const { appName, appLogoLightUrl, appLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  if (!XENAXIO_BFF) return null;
  const logo = withBasePath(resolvedTheme === "dark" ? appLogoDarkUrl || appLogoLightUrl : appLogoLightUrl || appLogoDarkUrl);
  if (!logo) return null;
  return (
    <div data-testid="menu-brand" className="lg:hidden flex items-center h-14 px-4 border-b border-border">
      <img src={logo} alt={appName} className="max-h-9 max-w-[180px] w-auto object-contain" />
    </div>
  );
}
