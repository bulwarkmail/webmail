import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MenuBrand } from "../menu-brand";

const config = vi.hoisted(() => ({ appName: "xenaxio", appLogoLightUrl: "/api/portal/logo?v=1", appLogoDarkUrl: "/api/portal/logo?v=1" }));

vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));
vi.mock("@/hooks/use-config", () => ({ useConfig: () => config }));

describe("MenuBrand (company logo in the phone menu)", () => {
  it("shows the company logo, on phone and tablet only", () => {
    render(<MenuBrand />);
    const row = screen.getByTestId("menu-brand");
    expect(row.className).toContain("lg:hidden");
    expect(row.querySelector("img")?.getAttribute("src")).toContain("/api/portal/logo?v=1");
  });

  it("shows nothing without a logo", () => {
    config.appLogoLightUrl = "";
    config.appLogoDarkUrl = "";
    render(<MenuBrand />);
    expect(screen.queryByTestId("menu-brand")).toBeNull();
  });
});
