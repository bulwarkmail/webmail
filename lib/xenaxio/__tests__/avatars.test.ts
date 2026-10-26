import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/xenaxio/bff", async (orig) => ({ ...(await orig<typeof import("@/lib/xenaxio/bff")>()), XENAXIO_BFF: true }));
const avatars = vi.fn();
vi.mock("@/lib/xenaxio/api", () => ({ xenaxio: { avatars: () => avatars() } }));

import { centerSquare, useXenaxioAvatarStore } from "../avatars";

describe("step 39: pictures", () => {
  beforeEach(() => {
    avatars.mockReset();
    useXenaxioAvatarStore.setState({ byEmail: {}, loadedAt: 0, loading: false });
  });

  it("cuts the middle square of a photo", () => {
    expect(centerSquare(4000, 3000)).toEqual({ x: 500, y: 0, side: 3000 });
    expect(centerSquare(1080, 1920)).toEqual({ x: 0, y: 420, side: 1080 });
    expect(centerSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
  });

  it("finds a picture by address, aliases and case included, and loads once", async () => {
    avatars.mockResolvedValue({
      avatars: [
        { email: "a.schmidt@acme.de", url: "/api/avatars/1?v=a" },
        { email: "anna@acme.de", url: "/api/avatars/1?v=a" },
      ],
    });
    await useXenaxioAvatarStore.getState().load();
    await useXenaxioAvatarStore.getState().load();
    expect(avatars).toHaveBeenCalledTimes(1);
    const byEmail = useXenaxioAvatarStore.getState().byEmail;
    expect(byEmail["a.schmidt@acme.de"]).toBe("/api/avatars/1?v=a");
    expect(byEmail["anna@acme.de"]).toBe("/api/avatars/1?v=a");

    // After a change the directory is asked again right away.
    avatars.mockResolvedValue({ avatars: [] });
    await useXenaxioAvatarStore.getState().load(true);
    expect(avatars).toHaveBeenCalledTimes(2);
    expect(useXenaxioAvatarStore.getState().byEmail).toEqual({});
  });

  it("stays on initials when the platform does not answer", async () => {
    avatars.mockRejectedValue(new Error("offline"));
    await useXenaxioAvatarStore.getState().load();
    expect(useXenaxioAvatarStore.getState().byEmail).toEqual({});
  });
});
