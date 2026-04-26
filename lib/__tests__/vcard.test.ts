import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseVCard, generateVCard, detectDuplicates } from "../vcard";
import type { ContactCard } from "@/lib/jmap/types";

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseVCard", () => {
  it("parses single vCard with FN (full name)", () => {
    const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:John Doe\r\nEMAIL:john@example.com\r\nEND:VCARD`;
    const result = parseVCard(vcf);

    expect(result).toHaveLength(1);
    const card = result[0];
    expect(card.id).toBe("import-test-uuid");
    expect(card.name?.components).toEqual(
      expect.arrayContaining([
        { kind: "given", value: "John" },
        { kind: "surname", value: "Doe" },
      ])
    );
    expect(card.emails?.e0?.address).toBe("john@example.com");
  });

  it("parses vCard with N field (structured name with all components)", () => {
    const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;John;Michael;Mr.;Jr.\r\nEMAIL:john@example.com\r\nEND:VCARD`;
    const result = parseVCard(vcf);

    expect(result).toHaveLength(1);
    const components = result[0].name?.components || [];
    expect(components).toEqual([
      { kind: "title", value: "Mr." },
      { kind: "given", value: "John" },
      { kind: "given2", value: "Michael" },
      { kind: "surname", value: "Doe" },
      { kind: "generation", value: "Jr." },
    ]);
  });

  it("N field overrides FN when both present", () => {
    const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:John Doe\r\nN:Doe;John;;;\r\nEMAIL:john@example.com\r\nEND:VCARD`;
    const result = parseVCard(vcf);

    // N comes after FN in raw lines, and N always sets card.name (overwrites FN)
    const components = result[0].name?.components || [];
    expect(components.find((c) => c.kind === "given")?.value).toBe("John");
    expect(components.find((c) => c.kind === "surname")?.value).toBe("Doe");
  });

  it("maps prefix and middle name to RFC 9553 standard kinds (issue #224)", () => {
    // N: family;given;additional;prefix;suffix (RFC 6350 order)
    const withPrefix = parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\nN:Smith;John;;Mr.;\r\nEMAIL:j@example.com\r\nEND:VCARD`);
    const c1 = withPrefix[0].name?.components || [];
    expect(c1.find((c) => c.kind === "surname")?.value).toBe("Smith");
    expect(c1.find((c) => c.kind === "given")?.value).toBe("John");
    expect(c1.find((c) => c.kind === "title")?.value).toBe("Mr.");

    const withMiddle = parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\nN:Smith;John;Mike;;\r\nEMAIL:j@example.com\r\nEND:VCARD`);
    const c2 = withMiddle[0].name?.components || [];
    expect(c2.find((c) => c.kind === "surname")?.value).toBe("Smith");
    expect(c2.find((c) => c.kind === "given")?.value).toBe("John");
    expect(c2.find((c) => c.kind === "given2")?.value).toBe("Mike");
  });

  it("parses vCard with phone, org, and address", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Jane Smith",
      "EMAIL;TYPE=WORK:jane@work.com",
      "TEL;TYPE=CELL:+1234567890",
      "ORG:Acme Corp;Engineering",
      "ADR;TYPE=WORK:;;123 Main St;City;State;12345;US",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const card = result[0];

    expect(card.emails?.e0?.address).toBe("jane@work.com");
    expect(card.emails?.e0?.contexts).toEqual({ work: true });

    expect(card.phones?.p0?.number).toBe("+1234567890");

    expect(card.organizations?.o0?.name).toBe("Acme Corp");
    expect(card.organizations?.o0?.units).toEqual([{ name: "Engineering" }]);

    expect(card.addresses?.a0).toMatchObject({
      street: "123 Main St",
      locality: "City",
      region: "State",
      postcode: "12345",
      country: "US",
      contexts: { work: true },
    });
  });

  it("parses vCard with nickname, notes, and UID", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Builder",
      "NICKNAME:Bobby",
      "NOTE:Important person",
      "UID:abc-123",
      "EMAIL:bob@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    const card = result[0];

    expect(card.nicknames?.n0?.name).toBe("Bobby");
    expect(card.notes?.n0?.note).toBe("Important person");
    expect(card.uid).toBe("abc-123");
  });

  it("parses multi-contact vCard file", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice",
      "EMAIL:alice@example.com",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob",
      "EMAIL:bob@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(2);
    expect(result[0].emails?.e0?.address).toBe("alice@example.com");
    expect(result[1].emails?.e0?.address).toBe("bob@example.com");
  });

  it("skips malformed vCards without name or email", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "NOTE:Just a note",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Valid Contact",
      "EMAIL:valid@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    expect(result[0].emails?.e0?.address).toBe("valid@example.com");
  });

  it("parses vCard with group kind and members", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Team Alpha",
      "KIND:group",
      "MEMBER:urn:uuid:member-1",
      "MEMBER:urn:uuid:member-2",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const card = result[0];

    expect(card.kind).toBe("group");
    expect(card.members).toEqual({ "member-1": true, "member-2": true });
  });

  it("handles folded lines (continuation with leading space)", () => {
    const vcf =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:John\r\n Doe\r\nEMAIL:john@example.com\r\nEND:VCARD";
    const result = parseVCard(vcf);

    expect(result).toHaveLength(1);
    expect(result[0].name?.components).toEqual(
      expect.arrayContaining([{ kind: "given", value: "JohnDoe" }])
    );
  });

  it("handles escaped characters", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Test User",
      "NOTE:Line one\\nLine two\\, with comma\\; and semicolon\\\\backslash",
      "EMAIL:test@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].notes?.n0?.note).toBe(
      "Line one\nLine two, with comma; and semicolon\\backslash"
    );
  });

  it("allows group kind without name or email", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "KIND:group",
      "MEMBER:urn:uuid:m1",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("group");
  });

  it("decodes ENCODING=QUOTED-PRINTABLE values with UTF-8 charset", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;Hans;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Hans M=C3=BCller",
      "NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9 stra=C3=9Fe",
      "EMAIL:hans@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const card = result[0];

    const components = card.name?.components || [];
    expect(components.find((c) => c.kind === "given")?.value).toBe("Hans");
    expect(components.find((c) => c.kind === "surname")?.value).toBe("Müller");
    expect(card.notes?.n0?.note).toBe("Café straße");
  });

  it("joins QUOTED-PRINTABLE soft line breaks (= at end of line)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Hans=20J=",
      "=C3=BCrgen=20M=C3=BCller",
      "EMAIL:hj@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const components = result[0].name?.components || [];
    const given = components.find((c) => c.kind === "given")?.value;
    const surname = components.find((c) => c.kind === "surname")?.value;
    expect(given).toBe("Hans");
    expect(surname).toBe("Jürgen Müller");
  });

  it("recognizes bare QUOTED-PRINTABLE encoding parameter (vCard 2.1 style)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN;QUOTED-PRINTABLE;CHARSET=UTF-8:Caf=C3=A9",
      "EMAIL:c@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    const components = result[0].name?.components || [];
    expect(components.find((c) => c.kind === "given")?.value).toBe("Café");
  });

  it("parses GENDER, LOGO, SOUND, LABEL, CALURI, CALADRURI, FBURL, SOURCE", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Jane Doe",
      "GENDER:F;Female",
      "LOGO;MEDIATYPE=image/png:https://example.com/logo.png",
      "SOUND;MEDIATYPE=audio/ogg:https://example.com/sound.ogg",
      "LABEL;TYPE=HOME:123 Main St\\nSpringfield, IL",
      "ADR;TYPE=HOME:;;123 Main St;Springfield;IL;62704;US",
      "CALURI:https://example.com/calendar/jane",
      "CALADRURI:https://example.com/calendar/jane/schedule",
      "FBURL:https://example.com/freebusy/jane",
      "SOURCE:https://example.com/jane.vcf",
      "EMAIL:jane@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const card = result[0];

    expect(card.speakToAs).toEqual({ grammaticalGender: "feminine", pronouns: { p0: { pronouns: "Female" } } });
    expect(card.media?.m0).toEqual({
      kind: "logo",
      uri: "https://example.com/logo.png",
      mediaType: "image/png",
    });
    expect(card.media?.m1).toEqual({
      kind: "sound",
      uri: "https://example.com/sound.ogg",
      mediaType: "audio/ogg",
    });
    expect(card.calendarUri).toBe("https://example.com/calendar/jane");
    expect(card.schedulingUri).toBe("https://example.com/calendar/jane/schedule");
    expect(card.freeBusyUri).toBe("https://example.com/freebusy/jane");
    expect(card.source).toBe("https://example.com/jane.vcf");
    // LABEL sets fullAddress on the ADR entry
    expect(card.addresses?.a0?.fullAddress).toBe("123 Main St\nSpringfield, IL");
  });
});

describe("generateVCard", () => {
  it("exports single contact with all fields", () => {
    const contact: ContactCard = {
      id: "c1",
      uid: "uid-1",
      addressBookIds: { ab1: true },
      kind: "individual",
      name: {
        components: [
          { kind: "prefix", value: "Dr." },
          { kind: "given", value: "Jane" },
          { kind: "additional", value: "Marie" },
          { kind: "surname", value: "Smith" },
          { kind: "suffix", value: "PhD" },
        ],
        isOrdered: true,
      },
      emails: {
        e0: { address: "jane@work.com", contexts: { work: true } },
        e1: { address: "jane@home.com", contexts: { private: true } },
      },
      phones: { p0: { number: "+1234567890", contexts: { work: true } } },
      organizations: {
        o0: { name: "Acme Corp", units: [{ name: "Engineering" }] },
      },
      addresses: {
        a0: {
          street: "123 Main St",
          locality: "City",
          region: "State",
          postcode: "12345",
          country: "US",
          contexts: { work: true },
        },
      },
      nicknames: { n0: { name: "JJ" } },
      notes: { n0: { note: "VIP client" } },
    };

    const vcf = generateVCard([contact]);

    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("END:VCARD");
    expect(vcf).toContain("VERSION:3.0");
    expect(vcf).toContain("UID:uid-1");
    expect(vcf).toContain("KIND:individual");
    expect(vcf).toContain("FN:Dr. Jane Marie Smith PhD");
    expect(vcf).toContain("N:Smith;Jane;Marie;Dr.;PhD");
    expect(vcf).toContain("NICKNAME:JJ");
    expect(vcf).toContain("EMAIL;TYPE=WORK:jane@work.com");
    expect(vcf).toContain("EMAIL;TYPE=HOME:jane@home.com");
    expect(vcf).toContain("TEL;TYPE=WORK:+1234567890");
    expect(vcf).toContain("ORG:Acme Corp;Engineering");
    expect(vcf).toContain("ADR;TYPE=WORK:;;123 Main St;City;State;12345;US");
    expect(vcf).toContain("NOTE:VIP client");
  });

  it("produces valid structure for minimal contact", () => {
    const contact: ContactCard = {
      id: "c2",
      addressBookIds: {},
      name: {
        components: [{ kind: "given", value: "Solo" }],
        isOrdered: true,
      },
    };

    const vcf = generateVCard([contact]);
    const lines = vcf.split("\r\n");

    expect(lines[0]).toBe("BEGIN:VCARD");
    expect(lines[1]).toBe("VERSION:3.0");
    expect(lines).toContain("FN:Solo");
    expect(lines).toContain("N:;Solo;;;");
    expect(lines[lines.length - 1]).toBe("END:VCARD");
  });

  it("exports GENDER, LOGO, SOUND, GEO, TZ, CALURI, CALADRURI, FBURL, SOURCE", () => {
    const contact: ContactCard = {
      id: "c-new",
      addressBookIds: {},
      name: {
        components: [{ kind: "given", value: "Jane" }],
        isOrdered: true,
      },
      speakToAs: { grammaticalGender: "feminine", pronouns: { p0: { pronouns: "Female" } } },
      media: {
        m0: { kind: "logo", uri: "https://example.com/logo.png", mediaType: "image/png" },
        m1: { kind: "sound", uri: "https://example.com/sound.ogg", mediaType: "audio/ogg" },
      },
      addresses: {
        a0: {
          street: "123 Main St",
          locality: "City",
          coordinates: "geo:37.386013,-122.082932",
          timeZone: "America/Los_Angeles",
        },
      },
      calendarUri: "https://example.com/calendar/jane",
      schedulingUri: "https://example.com/calendar/jane/schedule",
      freeBusyUri: "https://example.com/freebusy/jane",
      source: "https://example.com/jane.vcf",
    };

    const vcf = generateVCard([contact]);
    expect(vcf).toContain("GENDER:F;Female");
    expect(vcf).toContain("LOGO;VALUE=URI;MEDIATYPE=image/png:https://example.com/logo.png");
    expect(vcf).toContain("SOUND;VALUE=URI;MEDIATYPE=audio/ogg:https://example.com/sound.ogg");
    expect(vcf).toContain("GEO:geo:37.386013,-122.082932");
    expect(vcf).toContain("TZ:America/Los_Angeles");
    expect(vcf).toContain("CALURI:https://example.com/calendar/jane");
    expect(vcf).toContain("CALADRURI:https://example.com/calendar/jane/schedule");
    expect(vcf).toContain("FBURL:https://example.com/freebusy/jane");
    expect(vcf).toContain("SOURCE:https://example.com/jane.vcf");
  });

  it("encodes special characters in values", () => {
    const contact: ContactCard = {
      id: "c3",
      addressBookIds: {},
      name: {
        components: [{ kind: "given", value: "Test" }],
        isOrdered: true,
      },
      notes: { n0: { note: "Has comma, semicolon; and newline\nhere" } },
    };

    const vcf = generateVCard([contact]);
    expect(vcf).toContain("NOTE:Has comma\\, semicolon\\; and newline\\nhere");
  });
});

describe("round-trip: parse → generate → parse", () => {
  it("produces structurally equivalent data", () => {
    const original = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:John Doe",
      "N:Doe;John;;;",
      "EMAIL;TYPE=WORK:john@work.com",
      "TEL:+1234567890",
      "ORG:Acme Corp",
      "NICKNAME:JD",
      "NOTE:A note",
      "UID:round-trip-1",
      "END:VCARD",
    ].join("\r\n");

    const parsed = parseVCard(original);
    const exported = generateVCard(parsed);
    const reparsed = parseVCard(exported);

    expect(reparsed).toHaveLength(1);
    const a = parsed[0];
    const b = reparsed[0];

    expect(b.name?.components).toEqual(a.name?.components);
    expect(b.emails?.e0?.address).toBe(a.emails?.e0?.address);
    expect(b.phones?.p0?.number).toBe(a.phones?.p0?.number);
    expect(b.organizations?.o0?.name).toBe(a.organizations?.o0?.name);
    expect(b.nicknames?.n0?.name).toBe(a.nicknames?.n0?.name);
    expect(b.notes?.n0?.note).toBe(a.notes?.n0?.note);
    expect(b.uid).toBe(a.uid);
  });
});

describe("detectDuplicates", () => {
  it("detects duplicates by matching email (case-insensitive)", () => {
    const existing: ContactCard[] = [
      {
        id: "existing-1",
        addressBookIds: {},
        emails: { e0: { address: "Alice@Example.com" } },
      },
    ];
    const incoming: ContactCard[] = [
      {
        id: "new-1",
        addressBookIds: {},
        emails: { e0: { address: "alice@example.com" } },
      },
    ];

    const dupes = detectDuplicates(existing, incoming);
    expect(dupes.size).toBe(1);
    expect(dupes.get(0)).toBe("existing-1");
  });

  it("returns empty map when no duplicates", () => {
    const existing: ContactCard[] = [
      {
        id: "existing-1",
        addressBookIds: {},
        emails: { e0: { address: "alice@example.com" } },
      },
    ];
    const incoming: ContactCard[] = [
      {
        id: "new-1",
        addressBookIds: {},
        emails: { e0: { address: "bob@example.com" } },
      },
    ];

    const dupes = detectDuplicates(existing, incoming);
    expect(dupes.size).toBe(0);
  });

  it("handles contacts without emails", () => {
    const existing: ContactCard[] = [
      { id: "existing-1", addressBookIds: {} },
    ];
    const incoming: ContactCard[] = [
      { id: "new-1", addressBookIds: {} },
      {
        id: "new-2",
        addressBookIds: {},
        emails: { e0: { address: "a@b.com" } },
      },
    ];

    const dupes = detectDuplicates(existing, incoming);
    expect(dupes.size).toBe(0);
  });
});
