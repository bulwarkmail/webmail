import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { apiPath } from "./api-path";

describe("apiPath", () => {
  const original = process.env.NEXT_PUBLIC_BASE_PATH;

  afterEach(() => {
    process.env.NEXT_PUBLIC_BASE_PATH = original;
  });

  it("returns the path unchanged when NEXT_PUBLIC_BASE_PATH is empty", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "";
    expect(apiPath("/api/foo")).toBe("/api/foo");
  });

  it("returns the path unchanged when NEXT_PUBLIC_BASE_PATH is undefined", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(apiPath("/api/foo")).toBe("/api/foo");
  });

  it("prepends basePath when configured", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/webmail";
    expect(apiPath("/api/foo")).toBe("/webmail/api/foo");
  });

  it("does not double-prefix paths that already start with basePath", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/webmail";
    expect(apiPath("/webmail/api/foo")).toBe("/webmail/api/foo");
  });

  it("works with nested basePath values", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app/mail";
    expect(apiPath("/api/auth")).toBe("/app/mail/api/auth");
  });
});
