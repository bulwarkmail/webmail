import { describe, expect, it } from "vitest";
import {
  plainTextToComposerBody,
  rewriteCidImagesForEditor,
  replaceInlineImagePlaceholders,
  collectInlineImageCids,
  sniffImageMime,
  INLINE_IMAGE_PLACEHOLDER,
  splitRecipients,
  formatRecipient,
  parseRecipient,
  parseRecipientList,
  formatRecipientList,
  splitPastedRecipients,
  waitForPendingUploads,
  extractUserAuthoredText,
  formatRecipientEntry,
  expandRecipients,
  getQuoteBodies,
} from '../email-composer-utils';

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

describe("collectInlineImageCids", () => {
  it("returns an empty set for bodies without inline images", () => {
    expect(collectInlineImageCids("").size).toBe(0);
    expect(collectInlineImageCids("<p>hi</p><img src=\"https://x/y.png\">").size).toBe(0);
  });

  it("collects every rendered cid, deduplicated", () => {
    const cids = collectInlineImageCids(
      `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="a@x">` +
      `<p>text</p><img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="b@x">` +
      `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="a@x">`
    );
    expect([...cids].sort()).toEqual(["a@x", "b@x"]);
  });

  it("picks up the cids rewriteCidImagesForEditor just wrote (#543)", () => {
    const body = rewriteCidImagesForEditor(
      '<img src="cid:_Foxmail.1@2ae0db4e" type="image/png">'
    );
    expect(collectInlineImageCids(body).has("_Foxmail.1@2ae0db4e")).toBe(true);
  });

  it("ignores data-cid on non-image elements", () => {
    expect(collectInlineImageCids('<div data-cid="a"></div>').size).toBe(0);
  });
});

describe("sniffImageMime", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  it("detects a PNG embedded as application/octet-stream (#543)", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });

  it("detects JPEG, GIF, WebP and BMP", () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(
      sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))
    ).toBe("image/webp");
    expect(sniffImageMime(bytes(0x42, 0x4d, 0x36, 0x00))).toBe("image/bmp");
  });

  it("returns null for non-image and truncated input", () => {
    // "%PDF"
    expect(sniffImageMime(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull();
    expect(sniffImageMime(bytes(0x89, 0x50))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  it("does not mistake a RIFF container that is not WebP for an image", () => {
    // RIFF....AVI
    expect(
      sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x41, 0x56, 0x49, 0x20))
    ).toBeNull();
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

  it("still splits when an angle run never closes", () => {
    expect(
      splitRecipients("Ap Reinders <ap@x.com, Erwin Beets <erwin@x.com, jaco@x.com"),
    ).toEqual([
      "Ap Reinders <ap@x.com",
      "Erwin Beets <erwin@x.com",
      "jaco@x.com",
    ]);
  });

  it("splits when only the last entry closes its angle brackets", () => {
    expect(splitRecipients("Ap <ap@x.com, Bob <bob@y.com>")).toEqual([
      "Ap <ap@x.com",
      "Bob <bob@y.com>",
    ]);
  });

  it("does not count a `>` inside a quoted display name as closing the run", () => {
    expect(splitRecipients('Ap <ap@x.com, "b>c" <b@y.com>')).toEqual([
      "Ap <ap@x.com",
      '"b>c" <b@y.com>',
    ]);
  });

  it("keeps a group intact even when a member's angle run never closes", () => {
    expect(splitRecipients("Team: Ann <a@x.com, Bob <b@y.com;")).toEqual([
      "Team: Ann <a@x.com, Bob <b@y.com;",
    ]);
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

  it("recovers every recipient from a list whose closing brackets are missing", () => {
    const { valid, invalid } = splitPastedRecipients(
      "Ap Reinders <ap@x.com, Erwin Beets <erwin@x.com, jaco@x.com",
    );
    expect(valid).toEqual([
      { name: "Ap Reinders", email: "ap@x.com" },
      { name: "Erwin Beets", email: "erwin@x.com" },
      { email: "jaco@x.com" },
    ]);
    expect(invalid).toEqual([]);
  });

  it("keeps the display name of a `Name <email` entry missing its bracket", () => {
    const { valid, invalid } = splitPastedRecipients("John Doe <j@x.com");
    expect(valid).toEqual([{ name: "John Doe", email: "j@x.com" }]);
    expect(invalid).toEqual([]);
  });

  it("keeps both addresses when one entry carries two unclosed mailboxes", () => {
    // The name-preserving path keeps the last angle run only, so it must not
    // claim an entry whose prefix is an address itself - that would drop it.
    const { valid, invalid } = splitPastedRecipients("Ann <a@x.com Bob <b@y.com");
    expect(valid).toEqual([{ email: "a@x.com" }, { email: "b@y.com" }]);
    expect(invalid).toEqual(["Ann", "Bob"]);
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

describe('contact group recipients (RFC 5322 group syntax)', () => {
  const group = {
    name: 'Vertrieb',
    email: '',
    group: { members: [
      { name: 'Anna Alt', email: 'anna@example.com' },
      { email: 'bob@example.com' },
    ] },
  };

  it('formats a group chip as RFC 5322 group syntax', () => {
    expect(formatRecipientEntry(group)).toBe('Vertrieb: Anna Alt <anna@example.com>, bob@example.com;');
  });

  it('round-trips a group through format -> parse', () => {
    const parsed = parseRecipientList(formatRecipientList([group, { email: 'solo@example.com' }]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].group?.members).toEqual([
      { name: 'Anna Alt', email: 'anna@example.com' },
      { email: 'bob@example.com' },
    ]);
    expect(parsed[0].name).toBe('Vertrieb');
    expect(parsed[0].email).toBe('');
    expect(parsed[1]).toEqual({ email: 'solo@example.com' });
  });

  it('quotes group names containing specials and round-trips them', () => {
    const tricky = { name: 'Sales, EMEA', email: '', group: { members: [{ email: 'a@x.de' }] } };
    const parsed = parseRecipientList(formatRecipientList([tricky]));
    expect(parsed[0].name).toBe('Sales, EMEA');
    expect(parsed[0].group?.members).toEqual([{ email: 'a@x.de' }]);
  });

  it('keeps commas inside a group while splitting a mixed list', () => {
    const parsed = parseRecipientList('first@x.de, Team: a@x.de, b@x.de;, last@x.de');
    expect(parsed.map(r => r.email || r.name)).toEqual(['first@x.de', 'Team', 'last@x.de']);
    expect(parsed[1].group?.members).toHaveLength(2);
  });

  it('expandRecipients flattens groups and dedupes against individuals', () => {
    const expanded = expandRecipients([
      { name: 'Anna Alt', email: 'ANNA@example.com' },
      group,
      { email: 'bob@example.com' },
    ]);
    expect(expanded.map(r => r.email)).toEqual(['ANNA@example.com', 'bob@example.com']);
  });

  it('leaves plain recipients untouched by expansion', () => {
    expect(expandRecipients([{ name: 'X', email: 'x@y.z' }])).toEqual([{ name: 'X', email: 'x@y.z' }]);
  });
});

describe("getQuoteBodies", () => {
  const part = (partId: string, type: string) => ({ partId, blobId: "b", size: 1, type });

  it("converts an HTML-only message's shared part into readable text (#649)", () => {
    const { body, htmlBody } = getQuoteBodies({
      textBody: [part("1", "text/html")],
      htmlBody: [part("1", "text/html")],
      bodyValues: { "1": { value: "<p>Hallo Jonas.</p><p>Zeile zwei<br>und drei</p>" } },
    });
    expect(body).toBe("Hallo Jonas.\n\nZeile zwei\nund drei");
    expect(htmlBody).toContain("<p>Hallo Jonas.</p>");
  });

  it("drops htmlBody when it is really the text/plain part (#649)", () => {
    const text = "Hallo Herr Test,\n\ndas ist eine Test-Email.\n\nBeste Grüße";
    const { body, htmlBody } = getQuoteBodies({
      textBody: [part("1", "text/plain")],
      htmlBody: [part("1", "text/plain")],
      bodyValues: { "1": { value: text } },
    });
    expect(body).toBe(text);
    expect(htmlBody).toBeUndefined();
  });

  it("passes both parts through when the message has real alternatives", () => {
    const { body, htmlBody } = getQuoteBodies({
      textBody: [part("t", "text/plain")],
      htmlBody: [part("h", "text/html")],
      bodyValues: {
        t: { value: "plain version" },
        h: { value: "<p>html version</p>" },
      },
    });
    expect(body).toBe("plain version");
    expect(htmlBody).toBe("<p>html version</p>");
  });

  it("falls back to the preview when body values are missing", () => {
    const { body, htmlBody } = getQuoteBodies({ preview: "preview text" });
    expect(body).toBe("preview text");
    expect(htmlBody).toBeUndefined();
  });
});
