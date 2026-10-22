// Step 17: every company has its own address and login portal
// (<slug>.xenaxio.com or its own hostname). The platform says whose address
// this page was opened on (/api/portal); logo and colour come from there.
// On the shared address (app.xenaxio.com) a signed-in person is handed over
// to their company's portal with a one-time link.
import { useEffect } from "react";
import { create } from "zustand";
import { type Me, type PortalInfo, type PortalState, xenaxio, XenaxioApiError } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

const NO_PORTALS: PortalState = { kind: "app", portals: false, baseDomain: null };

let portalPromise: Promise<PortalState> | null = null;

/** Whose address this is; asked once per page load. */
export function loadPortal(): Promise<PortalState> {
  if (!XENAXIO_BFF) return Promise.resolve(NO_PORTALS);
  portalPromise ??= xenaxio
    .portal()
    .catch((err: unknown) => (err instanceof XenaxioApiError && err.status === 404 ? ({ kind: "unknown" } as const) : NO_PORTALS));
  return portalPromise;
}

const usePortalStore = create<{ portal: PortalState | null; set: (p: PortalState) => void }>((set) => ({
  portal: null,
  set: (portal) => set({ portal }),
}));

/** Portal of this address (null while loading). */
export function usePortal(): PortalState | null {
  const portal = usePortalStore((s) => s.portal);
  const set = usePortalStore((s) => s.set);
  useEffect(() => {
    if (!portal) void loadPortal().then(set);
  }, [portal, set]);
  return portal;
}

/** Logo, colour and name to show: this address's company, else the signed-in person's. */
export function activeBrand(portal: PortalState | null, me: Me | null): PortalInfo | null {
  if (portal?.kind === "tenant") return portal;
  if (portal?.kind === "app" && me?.portal) return me.portal;
  return null;
}

/** After a rename the same page on the new address. */
export function movedUrl(target: string, location: Pick<Location, "pathname" | "search" | "hash">): string {
  // Always the new address's own origin: a path like "//other.site/" must not become a host.
  const path = `/${location.pathname.replace(/^[/\\]+/, "")}`;
  return `${new URL(target).origin}${path}${location.search}${location.hash}`;
}

/** Pages that live on the shared address only: operator console, onboarding, AI chat consent. */
const SHARED_ONLY = /\/(operator|onboarding|connect|auth)(\/|$)/;

/** The person is on the shared address but their company has its own: hand over. */
export function shouldHandOff(portalUrl: string | null | undefined, origin: string, pathname: string): boolean {
  if (!portalUrl || SHARED_ONLY.test(pathname)) return false;
  try {
    return new URL(portalUrl).origin !== origin;
  } catch {
    return false;
  }
}

/** Moves the session to the company portal and opens `next` there. False if that failed. */
export async function goToPortal(next: string): Promise<boolean> {
  try {
    const { url } = await xenaxio.handoff(next);
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
}

/** Logo override for the mail app (config.json logos are xenaxio's). */
export async function portalLogo(): Promise<string | null> {
  const portal = await loadPortal();
  if (portal.kind === "tenant") return portal.logoUrl;
  // A single address without portals (on-prem): the signed-in person's company.
  if (portal.kind === "app" && !portal.portals) {
    return xenaxio.me().then(
      (me) => me.portal?.logoUrl ?? null,
      () => null,
    );
  }
  return null;
}

// --- Colour ---------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The company colour as the theme's primary colour. Dark mode keeps its own
 * when the brand colour would not stand out on the dark background.
 */
export function brandCss(color: string | null | undefined, text: string | null | undefined): string {
  if (!color || !HEX.test(color)) return "";
  const fg = text && HEX.test(text) ? text : contrastRatio(color, "#ffffff") >= contrastRatio(color, "#111111") ? "#ffffff" : "#111111";
  const vars = `--color-primary:${color};--color-primary-foreground:${fg};--color-ring:${color};`;
  const dark = contrastRatio(color, "#0a0a0a") >= 3 ? `html.dark{${vars}}` : "";
  return `html:not(.dark){${vars}}${dark}`;
}
