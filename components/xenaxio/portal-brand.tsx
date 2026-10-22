"use client";

// Step 17: applies the company portal to every page — its colour, forwarding
// after a rename, the hand-over from the shared address to the company's own
// one, and a clear page for addresses that belong to no company.
import { useEffect } from "react";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { activeBrand, brandCss, goToPortal, movedUrl, shouldHandOff, usePortal } from "@/lib/xenaxio/portal";
import { useXT } from "@/lib/xenaxio/i18n";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

/** Shared address: the signed-in person's company colour; with portals, the hand-over. */
function SignedIn({ handOff }: { handOff: boolean }) {
  const me = useXenaxioMe();
  const url = me?.portal?.url;
  useEffect(() => {
    if (!handOff || !url || !shouldHandOff(url, window.location.origin, window.location.pathname)) return;
    // Sign-in on the way to somewhere specific (e.g. an AI chat's consent page) stays here.
    if (new URLSearchParams(window.location.search).has("next")) return;
    void goToPortal(`${window.location.pathname}${window.location.search}`);
  }, [handOff, url]);
  return <BrandStyle color={me?.portal?.color} text={me?.portal?.colorText} />;
}

function BrandStyle({ color, text }: { color: string | null | undefined; text: string | null | undefined }) {
  const css = brandCss(color, text);
  // Only validated #rrggbb values reach the stylesheet.
  return css ? <style data-xenaxio-brand="">{css}</style> : null;
}

export function PortalBrand() {
  const t = useXT();
  const portal = usePortal();

  useEffect(() => {
    if (portal?.kind === "moved") window.location.replace(movedUrl(portal.url, window.location));
  }, [portal]);

  if (!XENAXIO_BFF || !portal) return null;
  if (portal.kind === "unknown") {
    return (
      <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-background px-4 text-center" role="alert">
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">{t("portal.unknown_title")}</h1>
          <p className="text-sm text-muted-foreground">{t("portal.unknown_text")}</p>
        </div>
      </div>
    );
  }
  // On the shared address: once signed in, continue on the company's own address.
  if (portal.kind === "app") return <SignedIn handOff={portal.portals} />;
  const brand = activeBrand(portal, null);
  return <BrandStyle color={brand?.color} text={brand?.colorText} />;
}
