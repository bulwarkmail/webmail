import { describe, expect, it } from "vitest";
import { activeBrand, brandCss, contrastRatio, movedUrl, shouldHandOff, withCompanyName } from "../portal";
import type { Me, PortalState } from "../api";

const acme = { name: "Acme", slug: "acme", url: "https://acme.xenaxio.com", color: "#003366", colorText: "#ffffff", logoUrl: "/api/portal/logo?v=1" };

describe("step 17: company portal", () => {
  it("hands over from the shared address, never from shared-only pages", () => {
    expect(shouldHandOff("https://acme.xenaxio.com", "https://app.xenaxio.com", "/de/")).toBe(true);
    expect(shouldHandOff("https://acme.xenaxio.com", "https://app.xenaxio.com", "/de/mail/")).toBe(true);
    expect(shouldHandOff("https://acme.xenaxio.com", "https://acme.xenaxio.com", "/de/")).toBe(false);
    for (const page of ["/de/operator/", "/de/onboarding/", "/en/connect/", "/de/auth/callback/"]) {
      expect(shouldHandOff("https://acme.xenaxio.com", "https://app.xenaxio.com", page)).toBe(false);
    }
    expect(shouldHandOff(null, "https://app.xenaxio.com", "/de/")).toBe(false);
    expect(shouldHandOff("not a url", "https://app.xenaxio.com", "/de/")).toBe(false);
  });

  it("keeps the page when forwarding to the renamed address", () => {
    expect(movedUrl("https://acme-neu.xenaxio.com", { pathname: "/de/mail/", search: "?x=1", hash: "#y" })).toBe("https://acme-neu.xenaxio.com/de/mail/?x=1#y");
    // Never another host, even with a path that looks like one.
    expect(movedUrl("https://acme-neu.xenaxio.com", { pathname: "//evil.example/", search: "", hash: "" })).toBe("https://acme-neu.xenaxio.com/evil.example/");
    expect(movedUrl("https://acme-neu.xenaxio.com", { pathname: "/\\evil.example/", search: "", hash: "" })).toBe("https://acme-neu.xenaxio.com/evil.example/");
  });

  it("brands with the portal's company, or the signed-in person's on the shared address", () => {
    const tenant: PortalState = { kind: "tenant", ...acme };
    const app: PortalState = { kind: "app", portals: false, baseDomain: null };
    const me = { portal: { ...acme, name: "Mine" } } as unknown as Me;
    expect(activeBrand(tenant, me)?.name).toBe("Acme");
    expect(activeBrand(app, me)?.name).toBe("Mine");
    expect(activeBrand(app, null)).toBe(null);
    expect(activeBrand({ kind: "unknown" }, me)).toBe(null);
  });

  it("turns the colour into theme variables, only for valid colours", () => {
    expect(brandCss("#003366", "#ffffff")).toBe(
      "html:not(.dark){--color-primary:#003366;--color-primary-foreground:#ffffff;--color-ring:#003366;}",
    );
    // A colour that stands out on the dark background is used there too.
    expect(brandCss("#facc15", null)).toContain("html.dark{--color-primary:#facc15;--color-primary-foreground:#111111;");
    expect(brandCss("red", null)).toBe("");
    expect(brandCss("#123456;}body{display:none", null)).toBe("");
    expect(brandCss(null, null)).toBe("");
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  it("starts the tab title with the company name", () => {
    expect(withCompanyName("Acme", "Posteingang (3) - jane@acme.de - xenaxio")).toBe("Acme - Posteingang (3) - jane@acme.de - xenaxio");
    expect(withCompanyName("Acme", "xenaxio")).toBe("Acme - xenaxio");
    expect(withCompanyName("Acme", "Acme - xenaxio")).toBe("Acme - xenaxio");
    expect(withCompanyName("Acme", "")).toBe("Acme");
    expect(withCompanyName(null, "xenaxio")).toBe("xenaxio");
    expect(withCompanyName("  ", "xenaxio")).toBe("xenaxio");
  });
});
