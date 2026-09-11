import { describe, it, expect } from "vitest";
import { realAttachments } from "../attachment-chips";
import type { Attachment } from "@/lib/jmap/types";

function att(over: Partial<Attachment>): Attachment {
  return { partId: "1", blobId: "b1", size: 100, type: "application/pdf", name: "doc.pdf", ...over };
}

describe("realAttachments", () => {
  it("returns nothing when the message has no attachments", () => {
    expect(realAttachments(undefined)).toEqual([]);
    expect(realAttachments([])).toEqual([]);
  });

  it("drops parts marked inline", () => {
    const kept = att({ name: "invoice.pdf" });
    const out = realAttachments([
      kept,
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", disposition: "inline" }),
    ]);
    expect(out).toEqual([kept]);
  });

  it("drops parts referenced by Content-ID even without a disposition", () => {
    // Outlook signature images arrive as cid: references; six of them on one
    // message would otherwise fill the row with 180-byte spacers.
    const out = realAttachments([
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", cid: "image001.png@01DD" }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops parts with no filename, which cannot be labelled or saved", () => {
    expect(realAttachments([att({ name: undefined })])).toEqual([]);
  });

  it("keeps genuine attachments in order", () => {
    const a = att({ partId: "1", blobId: "b1", name: "a.pdf" });
    const b = att({ partId: "2", blobId: "b2", name: "b.xlsx", type: "application/vnd.ms-excel" });
    expect(realAttachments([a, b])).toEqual([a, b]);
  });
});
