import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "@/components/ui/avatar";
import { useXenaxioAvatarStore } from "@/lib/xenaxio/avatars";

describe("step 41: the company picture in the mail app's Avatar", () => {
  it("shows the picture a colleague set before initials and favicons", () => {
    useXenaxioAvatarStore.setState({ byEmail: { "anna@acme.de": "/api/avatars/1?v=a" }, loadedAt: Date.now(), loading: false });
    const { container } = render(<Avatar name="Anna" email="Anna@acme.de" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/avatars/1?v=a");
    const other = render(<Avatar name="Lea Berg" email="lea@acme.de" disableFavicon />);
    expect(other.container.textContent).toBe("LB");
  });
});
