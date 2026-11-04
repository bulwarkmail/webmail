import { describe, expect, it } from "vitest";
import { quotaLevel, toFilesQuota, toStorageQuota } from "../quota";

const GB = 1024 ** 3;

describe("toStorageQuota", () => {
  it("uses hardLimit when there is no softLimit", () => {
    expect(toStorageQuota([{ resourceType: "octets", used: 1, hardLimit: GB }])).toEqual({ used: 1, total: GB });
  });

  it("treats a softLimit below hardLimit as 100% and keeps hardLimit aside (#1242)", () => {
    const quota = toStorageQuota([{ resourceType: "octets", used: GB, hardLimit: 1.1 * GB, softLimit: GB }]);
    expect(quota).toEqual({ used: GB, total: GB, hardLimit: 1.1 * GB });
    expect(quotaLevel(quota!)).toBe("full");
  });

  it("ignores a softLimit that is null, zero or not below hardLimit", () => {
    for (const softLimit of [null, 0, GB, 2 * GB]) {
      expect(toStorageQuota([{ resourceType: "octets", used: 0, hardLimit: GB, softLimit }])).toEqual({ used: 0, total: GB });
    }
  });

  it("falls back to the pre-RFC limit field", () => {
    expect(toStorageQuota([{ scope: "mail", used: 5, limit: 10 }])).toEqual({ used: 5, total: 10 });
  });

  it("keeps warnLimit only when it is below the effective limit", () => {
    expect(toStorageQuota([{ resourceType: "octets", used: 0, hardLimit: 100, softLimit: 80, warnLimit: 50 }])?.warnAt).toBe(50);
    expect(toStorageQuota([{ resourceType: "octets", used: 0, hardLimit: 100, softLimit: 80, warnLimit: 90 }])?.warnAt).toBeUndefined();
  });

  it("skips quotas that don't cover mail", () => {
    expect(toStorageQuota([{ resourceType: "octets", types: ["FileNode"], used: 1, hardLimit: 2 }])).toBeNull();
  });
});

describe("quotaLevel", () => {
  it("warns from warnLimit when the server sets one", () => {
    expect(quotaLevel({ used: 40, total: 100, warnAt: 40 })).toBe("warn");
    expect(quotaLevel({ used: 39, total: 100, warnAt: 40 })).toBe("ok");
  });

  it("warns above 70% without a warnLimit and is full above 90%", () => {
    expect(quotaLevel({ used: 70, total: 100 })).toBe("ok");
    expect(quotaLevel({ used: 71, total: 100 })).toBe("warn");
    expect(quotaLevel({ used: 91, total: 100, warnAt: 95 })).toBe("full");
  });
});

describe("toFilesQuota", () => {
  // What Quota/get answered for dso-quota@example.org (100 MB limit, 1 MB in Files) on the VM 106
  // servers, 2026-11-04. Without a limit both answer an empty list.
  const STALWART_1_0 = { id: "a", resourceType: "octets", used: 1048816, warnLimit: null, softLimit: null, hardLimit: 104857600, scope: "account", name: "dso-quota@example.org", types: ["Email", "SieveScript", "FileNode", "CalendarEvent", "ContactCard"] };
  const STALWART_0_16 = { ...STALWART_1_0, used: 1048776 };

  it("reads Stalwart's shared account quota on 1.0 and 0.16", () => {
    expect(toFilesQuota([STALWART_1_0])).toEqual({ used: 1048816, total: 104857600 });
    expect(toFilesQuota([STALWART_0_16])).toEqual({ used: 1048776, total: 104857600 });
    expect(toFilesQuota([])).toBeNull();
  });

  it("prefers a quota of Files alone over a shared one, and takes one without types last", () => {
    const files = { resourceType: "octets", types: ["FileNode"], used: 5, hardLimit: 50 };
    const untyped = { resourceType: "octets", used: 7, hardLimit: 70 };
    expect(toFilesQuota([STALWART_1_0, files])).toEqual({ used: 5, total: 50 });
    expect(toFilesQuota([untyped, STALWART_1_0])).toEqual({ used: 1048816, total: 104857600 });
    expect(toFilesQuota([untyped])).toEqual({ used: 7, total: 70 });
  });

  it("ignores quotas that aren't storage or don't cover Files", () => {
    expect(toFilesQuota([{ resourceType: "count", types: ["FileNode"], used: 3, hardLimit: 10 }])).toBeNull();
    expect(toFilesQuota([{ resourceType: "octets", types: ["Email"], used: 3, hardLimit: 10 }])).toBeNull();
  });
});
