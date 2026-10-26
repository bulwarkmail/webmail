import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The welcome box above the mail list came back on every visit: the browser
// storage it was kept in did not last. The platform now remembers it per user.

const api = vi.hoisted(() => ({ me: vi.fn(), dismissHint: vi.fn() }));
vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));
vi.mock("@/lib/xenaxio/api", () => ({ xenaxio: api }));
vi.mock("@/hooks/use-media-query", () => ({ useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }) }));
vi.mock("@/components/tour/tour-provider", () => ({ useTour: () => ({ startTour: vi.fn() }) }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { WelcomeBanner } = await import("@/components/ui/welcome-banner");
const { useXenaxioMeStore } = await import("@/lib/xenaxio/me-store");
const { useSettingsStore } = await import("@/stores/settings-store");

const me = (dismissedHints: string[]) => ({
  user: { id: "u1", email: "anna@acme.de", displayName: "Anna", role: "user" as const, mustChangePassword: false },
  tenant: { id: "t1", name: "Acme", status: "active" as const },
  edition: "cloud" as const,
  dismissedHints,
});

describe("WelcomeBanner in xenaxio", () => {
  beforeEach(() => {
    api.me.mockReset();
    api.dismissHint.mockReset().mockResolvedValue({ dismissedHints: ["welcome"] });
    useXenaxioMeStore.setState({ me: null, loadedAt: 0, loading: false });
  });

  it("stays hidden when the user closed it before, whatever this browser remembers", async () => {
    useSettingsStore.setState({ onboardingCompleted: false });
    api.me.mockResolvedValue(me(["welcome"]));
    await act(async () => render(<WelcomeBanner />));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows until closed and tells the platform", async () => {
    useSettingsStore.setState({ onboardingCompleted: true });
    api.me.mockResolvedValue(me([]));
    await act(async () => render(<WelcomeBanner />));
    expect(screen.getByRole("complementary")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("got_it")));
    expect(api.dismissHint).toHaveBeenCalledWith("welcome");
    expect(useXenaxioMeStore.getState().me?.dismissedHints).toEqual(["welcome"]);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not flash up before the platform has answered", () => {
    api.me.mockReturnValue(new Promise(() => {}));
    render(<WelcomeBanner />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
