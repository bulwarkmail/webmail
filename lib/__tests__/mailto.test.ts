import { describe, it, expect } from "vitest";
import { parseMailto } from "@/lib/protocol-handlers/mailto";
import { formatRecipient, parseRecipientList } from "@/lib/email-composer-utils";

// Build a mailto: URL the way a recipient picker encodes one: each recipient
// percent-encoded and comma-joined, To in the path, Cc/Bcc in a query param.
// Used only to exercise parseMailto's quote-aware recipient splitting.
function encodeMailto(recipients: string[], field: "to" | "cc" | "bcc"): string {
  const encoded = recipients.map((r) => encodeURIComponent(r)).join(",");
  return field === "to" ? `mailto:${encoded}` : `mailto:?${field}=${encoded}`;
}

describe("parseMailto display-name handling", () => {
  it("preserves display names through the mailto round-trip", () => {
    const recipients = [
      formatRecipient("Alice Smith", "alice@x.com"),
      formatRecipient("Bob", "bob@y.com"),
    ];
    const parsed = parseMailto(encodeMailto(recipients, "to"));
    expect(parseRecipientList(parsed!.to.join(", "))).toEqual([
      { name: "Alice Smith", email: "alice@x.com" },
      { name: "Bob", email: "bob@y.com" },
    ]);
  });

  it("keeps a display name containing a comma intact (quote-aware split)", () => {
    const recipients = [
      formatRecipient("Doe, John", "john@doe.org"), // -> "Doe, John" <john@doe.org>
      "alice@x.com",
    ];
    const parsed = parseMailto(encodeMailto(recipients, "cc"));
    expect(parsed!.cc).toEqual(['"Doe, John" <john@doe.org>', "alice@x.com"]);
    expect(parseRecipientList(parsed!.cc.join(", "))).toEqual([
      { name: "Doe, John", email: "john@doe.org" },
      { email: "alice@x.com" },
    ]);
  });
});
