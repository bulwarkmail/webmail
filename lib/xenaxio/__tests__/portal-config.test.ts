import { describe, expect, it, vi } from "vitest";
import type { ConfigData } from "@/hooks/use-config";

vi.mock("@/lib/xenaxio/bff", () => ({ XENAXIO_BFF: true }));
vi.mock("@/lib/xenaxio/portal", () => ({ portalLogo: async () => "/api/portal/logo?v=1" }));

const { productLogoUrls, withPortalLogo } = await import("../portal-config");

describe("step 17: company logo in the mail app", () => {
  it("replaces the app logo but keeps the product logo for the About card", async () => {
    const config = { appLogoLightUrl: "/branding/xenaxio-mark.png", appLogoDarkUrl: "/branding/xenaxio-mark.png" } as ConfigData;
    const out = await withPortalLogo(config);
    expect(out.appLogoLightUrl).toBe("/api/portal/logo?v=1");
    expect(out.appLogoDarkUrl).toBe("/api/portal/logo?v=1");
    expect(productLogoUrls()).toEqual({ light: "/branding/xenaxio-mark.png", dark: "/branding/xenaxio-mark.png" });
  });
});
