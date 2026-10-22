import { describe, expect, it, vi } from "vitest";
import type { ShareNotification } from "@/lib/jmap/types";

vi.mock("../bff", () => ({ XENAXIO_BFF: true }));
const { isQuietFreeBusyNotice } = await import("../free-busy");

const notice = (oldRights: ShareNotification["oldRights"], newRights: ShareNotification["newRights"], objectType = "Calendar"): ShareNotification => ({
  id: "n1",
  created: "2026-10-22T10:00:00Z",
  changedBy: { name: "Lea", email: "lea@firma.de", principalId: "7" },
  objectType,
  objectAccountId: "7",
  objectId: "b",
  name: "",
  oldRights,
  newRights,
});
const none = { mayReadFreeBusy: false, mayReadItems: false, mayWriteAll: false };
const freeBusy = { mayReadFreeBusy: true, mayReadItems: false, mayWriteAll: false };
const read = { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false };

describe("free/busy share notices (step 16)", () => {
  it("are quiet when a colleague gets or loses free/busy only", () => {
    expect(isQuietFreeBusyNotice(notice(none, freeBusy))).toBe(true);
    expect(isQuietFreeBusyNotice(notice(null, freeBusy))).toBe(true);
    expect(isQuietFreeBusyNotice(notice(freeBusy, none))).toBe(true);
  });

  it("still show a real share of a calendar or of anything else", () => {
    expect(isQuietFreeBusyNotice(notice(none, read))).toBe(false);
    expect(isQuietFreeBusyNotice(notice(freeBusy, read))).toBe(false);
    expect(isQuietFreeBusyNotice(notice(read, none))).toBe(false);
    expect(isQuietFreeBusyNotice(notice(none, { mayReadItems: true }, "Mailbox"))).toBe(false);
  });
});
