import { describe, expect, it } from "vitest";
import { VIEW_PLACES_MAX, withView } from "../view-prefs";

describe("withView (step 125)", () => {
  it("replaces a place and moves it to the end", () => {
    const next = withView({ a: { x: 1 }, b: { x: 2 } }, "a", { x: 3 });
    expect(Object.keys(next)).toEqual(["b", "a"]);
    expect(next.a).toEqual({ x: 3 });
  });

  it("drops the places used longest ago beyond the limit", () => {
    const views = Object.fromEntries(Array.from({ length: VIEW_PLACES_MAX }, (_, i) => [`p${i}`, { i }]));
    const next = withView(views, "new", { i: -1 });
    expect(Object.keys(next)).toHaveLength(VIEW_PLACES_MAX);
    expect(next.p0).toBeUndefined();
    expect(next.new).toEqual({ i: -1 });
  });
});
