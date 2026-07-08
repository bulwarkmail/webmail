import { describe, expect, it } from "vitest";
import {
  plainTextToComposerBody,
  rewriteCidImagesForEditor,
  replaceInlineImagePlaceholders,
  INLINE_IMAGE_PLACEHOLDER,
  splitRecipients,
  formatRecipient,
  parseRecipient,
  parseRecipientList,
  formatRecipientList,
  splitPastedRecipients,
  waitForPendingUploads,
  extractUserAuthoredText,
} from "../email-composer-utils";

const FORWARDED_SEPARATOR = "---------- Forwarded message ----------";

describe("extractUserAuthoredText", () => {
  const scan = (body: string, plainTextMode: boolean) =>
    extractUserAuthoredText(body, {
      plainTextMode,
      forwardedSeparator: FORWARDED_SEPARATOR,
    }).toLowerCase();

  it("keeps user text and drops the quoted island on an HTML reply (#570)", () => {
    const body =
      "<p>Here is my reply.</p>" +
      '<div>On Mon, Someone wrote:</div>' +
      '<div data-quoted-html><p>Please find attached the invoice (anexo).</p></div>';
    const result = scan(body, false);
    expect(result).toContain("here is my reply");
    expect(result).not.toContain("anexo");
    expect(result).not.toContain("attached");
  });

  it("drops a <blockquote> quote when the original had no HTML part", () => {
    const body =
      "<p>Thanks!</p>" +
      '<blockquote>segue em anexo o documento</blockquote>';
    const result = scan(body, false);
    expect(result).toContain("thanks");
    expect(result).not.toContain("anexo");
  });

  it("drops the forwarded header and original on an HTML forward", () => {
    const body =
      "<p>FYI</p><br><br>" +
      FORWARDED_SEPARATOR +
      "<br>From: a@b.com<br>Subject: Invoice attached<br><br>" +
      '<div data-quoted-html><p>em anexo</p></div>';
    const result = scan(body, false);
    expect(result).toContain("fyi");
    expect(result).not.toContain("anexo");
    expect(result).not.toContain("attached");
    expect(result).not.toContain("forwarded message");
  });

  it("drops '>' quoted lines on a plain-text reply", () => {
    const body = "My reply here.\n\nOn Mon, X wrote:\n> please find attached\n> anexo";
    const result = scan(body, true);
    expect(result).toContain("my reply here");
    expect(result).not.toContain("attached");
    expect(result).not.toContain("anexo");
  });

  it("drops the bare forwarded original on a plain-text forward", () => {
    const body =
      "See below.\n\n" +
      FORWARDED_SEPARATOR +
      "\nFrom: a@b.com\nSubject: hi\n\nem anexo o contrato";
    const result = scan(body, true);
    expect(result).toContain("see below");
    expect(result).not.toContain("anexo");
  });

  it("still surfaces a keyword the user actually typed", () => {
    const body =
      "<p>See the attached file.</p>" +
      '<div data-quoted-html><p>nothing here</p></div>';
    expect(scan(body, false)).toContain("attached");
  });

  it("tolerates a missing forwarded separator", () => {
    expect(scan("<p>plain reply</p>", false)).toContain("plain reply");
  });
});

describe("plainTextToComposerBody", () => {
  it("returns an empty string for empty input", () => {
    expect(plainTextToComposerBody("")).toBe("");
  });

  it("escapes HTML before building composer paragraphs", () => {
    expect(plainTextToComposerBody("<script>alert('x') & \"q\"</script>")).toBe(
      "<p>&lt;script&gt;alert(&#39;x&#39;) &amp; &quot;q&quot;&lt;/script&gt;</p>"
    );
  });

  it("normalizes line endings and preserves single line breaks", () => {
    expect(plainTextToComposerBody("line1\r\nline2\rline3")).toBe(
      "<p>line1<br>line2<br>line3</p>"
    );
  });

  it("splits paragraphs on blank lines", () => {
    expect(plainTextToComposerBody("first\n\nsecond\nthird")).toBe(
      "<p>first</p><p>second<br>third</p>"
    );
  });
});

describe("rewriteCidImagesForEditor", () => {
  it("returns input unchanged when no cid: refs are present", () => {
    const html = '<p>hi</p><img src="https://example.com/x.png">';
    expect(rewriteCidImagesForEditor(html)).toBe(html);
  });

  it("handles empty input", () => {
    expect(rewriteCidImagesForEditor("")).toBe("");
  });

  it("rewrites a cid: src to placeholder + data-cid", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="cid:abc@x" alt="logo">'
    );
    expect(out).toContain('data-cid="abc@x"');
    expect(out).toContain(`src="${INLINE_IMAGE_PLACEHOLDER}"`);
    expect(out).toContain('alt="logo"');
    expect(out).not.toContain('src="cid:');
  });

  it("preserves an existing data-cid attribute", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="cid:abc" data-cid="kept">'
    );
    expect(out).toContain('data-cid="kept"');
    expect(out).not.toContain('data-cid="abc"');
  });

  it("leaves non-cid images alone", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="https://example.com/x.png"><img src="cid:y">'
    );
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('data-cid="y"');
  });
});

describe("replaceInlineImagePlaceholders", () => {
  it("returns input unchanged when the map is empty", () => {
    const html = '<img src="..." data-cid="x">';
    expect(replaceInlineImagePlaceholders(html, new Map())).toBe(html);
  });

  it("swaps the placeholder src to the data URL for matching cids", () => {
    const html = `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="abc">`;
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('data-cid="abc"');
  });

  it("also rewrites raw cid: src refs that lack a placeholder", () => {
    const html = '<img src="cid:abc" data-cid="abc">';
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("does not overwrite images the user has re-pointed away from the cid", () => {
    const html =
      '<img src="https://example.com/other.png" data-cid="abc">';
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="https://example.com/other.png"');
    expect(out).not.toContain("data:image/png;base64,AAAA");
  });

  it("leaves unknown cids untouched", () => {
    const html = `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="missing">`;
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toBe(html);
  });
});

describe("splitRecipients", () => {
  it("splits a plain comma-separated list", () => {
    expect(splitRecipients("alice@x.com, bob@x.com")).toEqual([
      "alice@x.com",
      "bob@x.com",
    ]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(splitRecipients("  alice@x.com ,, bob@x.com ,")).toEqual([
      "alice@x.com",
      "bob@x.com",
    ]);
  });

  it("keeps a quoted display name containing a comma intact", () => {
    expect(splitRecipients('"Doo, John" <john@doo.org>, alice@x.com')).toEqual([
      '"Doo, John" <john@doo.org>',
      "alice@x.com",
    ]);
  });

  it("does not split on a comma inside angle brackets", () => {
    expect(splitRecipients("Group <a,b@x.com>, c@x.com")).toEqual([
      "Group <a,b@x.com>",
      "c@x.com",
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitRecipients("")).toEqual([]);
  });

  it("only splits on the given separators (default comma keeps semicolons/newlines literal)", () => {
    expect(splitRecipients("a@x.com; b@y.com")).toEqual(["a@x.com; b@y.com"]);
  });

  it("splits on a wider separator set while keeping quotes/angles literal", () => {
    expect(
      splitRecipients('"Doo, John" <john@doo.org>; a@x.com\nb@y.com', ',;\n\r'),
    ).toEqual(['"Doo, John" <john@doo.org>', "a@x.com", "b@y.com"]);
  });
});

describe("formatRecipient / parseRecipient", () => {
  it("returns a bare email when there is no name", () => {
    expect(formatRecipient(undefined, "a@x.com")).toBe("a@x.com");
  });

  it("returns a bare email when the name equals the email", () => {
    expect(formatRecipient("a@x.com", "a@x.com")).toBe("a@x.com");
  });

  it("formats a simple name without quoting", () => {
    expect(formatRecipient("Alice", "a@x.com")).toBe("Alice <a@x.com>");
  });

  it("quotes a name containing a comma", () => {
    expect(formatRecipient("Doo, John", "john@doo.org")).toBe(
      '"Doo, John" <john@doo.org>'
    );
  });

  it("parses a bare email", () => {
    expect(parseRecipient("a@x.com")).toEqual({ email: "a@x.com" });
  });

  it("parses and unquotes a quoted comma name", () => {
    expect(parseRecipient('"Doo, John" <john@doo.org>')).toEqual({
      name: "Doo, John",
      email: "john@doo.org",
    });
  });
});

describe("parseRecipientList / formatRecipientList", () => {
  it("round-trips a comma-name recipient through serialize + parse", () => {
    const list = [
      { name: "Doo, John", email: "john@doo.org" },
      { email: "alice@x.com" },
    ];
    const serialized = formatRecipientList(list);
    expect(serialized).toBe('"Doo, John" <john@doo.org>, alice@x.com');
    expect(parseRecipientList(serialized)).toEqual(list);
  });

  it("parses an empty string to an empty array", () => {
    expect(parseRecipientList("")).toEqual([]);
  });
});

describe("splitPastedRecipients", () => {
  it("splits on commas, semicolons and whitespace (incl. newline/tab)", () => {
    const { valid, invalid } = splitPastedRecipients(
      "a@x.com, b@y.com; c@z.com\nd@w.com\te@v.com f@u.com",
    );
    expect(valid.map((r) => r.email)).toEqual([
      "a@x.com", "b@y.com", "c@z.com", "d@w.com", "e@v.com", "f@u.com",
    ]);
    expect(invalid).toEqual([]);
  });

  it("collapses runs of mixed separators and drops empties", () => {
    const { valid } = splitPastedRecipients("  a@x.com ,;  , b@y.com  ");
    expect(valid.map((r) => r.email)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("partitions invalid tokens into `invalid`, keeping valid as chips", () => {
    const { valid, invalid } = splitPastedRecipients("a@x.com not-an-email b@y.com");
    expect(valid.map((r) => r.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(invalid).toEqual(["not-an-email"]);
  });

  it("unwraps an angle-bracketed token before validating", () => {
    const { valid } = splitPastedRecipients("<a@x.com>");
    expect(valid).toEqual([{ email: "a@x.com" }]);
  });

  it("keeps a `Name <email>` pair as a single chip with its display name", () => {
    const { valid, invalid } = splitPastedRecipients("John Doe <j@x.com>");
    expect(valid).toEqual([{ name: "John Doe", email: "j@x.com" }]);
    expect(invalid).toEqual([]);
  });

  it("keeps a fully-quoted `\"Name <email>\"` entry with its display name", () => {
    const { valid, invalid } = splitPastedRecipients(
      '"Alice Smith <alice@x.com>", "Alex Smith <alex@x.com>"',
    );
    expect(valid).toEqual([
      { name: "Alice Smith", email: "alice@x.com" },
      { name: "Alex Smith", email: "alex@x.com" },
    ]);
    expect(invalid).toEqual([]);
  });

  it("keeps a comma inside a quoted display name intact", () => {
    const { valid } = splitPastedRecipients('"Doe, John" <j@x.com>; bob@z.com');
    expect(valid).toEqual([
      { name: "Doe, John", email: "j@x.com" },
      { email: "bob@z.com" },
    ]);
  });

  it("dedupes case-insensitively within the paste and against existing emails", () => {
    const { valid } = splitPastedRecipients(
      "a@x.com A@X.com b@y.com c@z.com",
      ["B@Y.com"],
    );
    expect(valid.map((r) => r.email)).toEqual(["a@x.com", "c@z.com"]);
  });

  it("returns empty arrays for blank input", () => {
    expect(splitPastedRecipients("   ")).toEqual({ valid: [], invalid: [] });
  });
});

describe("waitForPendingUploads", () => {
  const att = (over: Partial<{ uploading: boolean; error: boolean }> = {}) => ({
    name: "file.pdf",
    type: "application/pdf",
    size: 100,
    ...over,
  });

  it("resolves 'completed' immediately when nothing is uploading", async () => {
    const result = await waitForPendingUploads(
      () => [att({}), att({})],
      () => false,
      1
    );
    expect(result).toBe("completed");
  });

  it("polls until in-flight uploads finish, then resolves 'completed'", async () => {
    let list = [att({ uploading: true }), att({})];
    setTimeout(() => {
      list = [att({}), att({})];
    }, 10);
    const result = await waitForPendingUploads(() => list, () => false, 1);
    expect(result).toBe("completed");
  });

  it("resolves 'failed' when an upload finishes with an error during the wait", async () => {
    let list = [att({ uploading: true })];
    setTimeout(() => {
      list = [att({ error: true })];
    }, 10);
    const result = await waitForPendingUploads(() => list, () => false, 1);
    expect(result).toBe("failed");
  });

  it("resolves 'failed' when another attachment is already errored once uploads finish", async () => {
    let list = [att({ uploading: true }), att({ error: true })];
    setTimeout(() => {
      list = [att({}), att({ error: true })];
    }, 10);
    const result = await waitForPendingUploads(() => list, () => false, 1);
    expect(result).toBe("failed");
  });

  it("resolves 'cancelled' when cancellation is signalled mid-wait", async () => {
    let cancelled = false;
    const list = [att({ uploading: true })];
    setTimeout(() => {
      cancelled = true;
    }, 10);
    const result = await waitForPendingUploads(
      () => list,
      () => cancelled,
      1
    );
    expect(result).toBe("cancelled");
  });

  it("prefers 'cancelled' over 'failed' when the draft is closed while an errored upload is pending", async () => {
    let cancelled = false;
    let list = [att({ uploading: true })];
    setTimeout(() => {
      list = [att({ error: true, uploading: true })];
      cancelled = true;
    }, 10);
    const result = await waitForPendingUploads(
      () => list,
      () => cancelled,
      1
    );
    expect(result).toBe("cancelled");
  });
});
