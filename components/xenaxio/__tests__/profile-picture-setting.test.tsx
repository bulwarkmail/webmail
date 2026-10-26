import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));

import { useXenaxioMeStore } from "@/lib/xenaxio/me-store";
import { ProfilePictureSetting } from "../profile-picture-setting";

describe("step 41: profile picture in Settings → Account", () => {
  it("shows the own picture with change and remove", () => {
    useXenaxioMeStore.setState({
      me: {
        user: { id: "u1", email: "anna@acme.de", displayName: "Anna", role: "user", mustChangePassword: false },
        tenant: { id: "t1", name: "Acme", status: "active" },
        edition: "cloud",
        avatarUrl: "/api/avatars/u1?v=a",
      },
      loadedAt: Date.now(),
    });
    render(<ProfilePictureSetting />);
    expect(screen.getByText("Profilbild")).toBeTruthy();
    expect(screen.getByAltText("Profilbild von Anna").getAttribute("src")).toBe("/api/avatars/u1?v=a");
    expect(screen.getByText("Foto ändern")).toBeTruthy();
    expect(screen.getByText("Entfernen")).toBeTruthy();
  });
});
