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

  it("uses the organization name as FN for organization cards (issue #701)", () => {
    const contact: ContactCard = {
      id: "c4",
      addressBookIds: {},
      kind: "org",
      name: { full: "Acme Corp" },
      organizations: { o0: { name: "Acme Corp" } },
    };

    const vcf = generateVCard([contact]);
    expect(vcf).toContain("KIND:org");
    expect(vcf).toContain("FN:Acme Corp");
    expect(vcf).toContain("ORG:Acme Corp");
  });

  it("falls back to ORG for FN when the card has no name at all", () => {
    const contact: ContactCard = {
      id: "c5",
      addressBookIds: {},
      kind: "org",
      organizations: { o0: { name: "Acme Corp" } },
    };

    expect(generateVCard([contact])).toContain("FN:Acme Corp");
  });
});

describe("organization-only cards (issue #701)", () => {
  it("keeps a vCard that has only an organization name", () => {
    const parsed = parseVCard([
      "BEGIN:VCARD",
      "VERSION:4.0",
      "KIND:org",
      "ORG:Acme Corp",
      "END:VCARD",
    ].join("\r\n"));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("org");
    expect(parsed[0].organizations?.o0.name).toBe("Acme Corp");
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

describe("vCard 4.0 parsing (issue #289)", () => {
  it("strips group prefix from property names (item1.EMAIL)", () => {
    // Evolution / Apple Contacts emit grouped properties so an X-ABLABEL line
    // can attach a label. We must still parse the EMAIL itself.
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Ada Lovelace",
      "item1.EMAIL:ada@example.com",
      "item1.X-ABLABEL:Personal",
      "item2.TEL:tel:+1-555-0100",
      "item2.X-ABLABEL:Mobile",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result).toHaveLength(1);
    const card = result[0];
    expect(card.emails?.e0?.address).toBe("ada@example.com");
    expect(card.phones?.p0?.number).toBe("+1-555-0100");
  });

  it("strips tel:/mailto: URI scheme from TEL/EMAIL values", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Alan Turing",
      "EMAIL:mailto:alan@example.com",
      "TEL;VALUE=uri:tel:+44-20-1234-5678",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].emails?.e0?.address).toBe("alan@example.com");
    expect(result[0].phones?.p0?.number).toBe("+44-20-1234-5678");
  });

  it("maps PREF=n parameter to pref field", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Grace Hopper",
      "EMAIL;PREF=1:grace@home.example",
      "EMAIL;PREF=2:grace@work.example",
      "TEL;PREF=1:+1-555-9999",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].emails?.e0?.pref).toBe(1);
    expect(result[0].emails?.e1?.pref).toBe(2);
    expect(result[0].phones?.p0?.pref).toBe(1);
  });

  it("decodes RFC 6868 caret-encoded parameter values", () => {
    // ^n → LF, ^^ → ^, ^' → DQUOTE
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Test",
      'ADR;LABEL="Line 1^nLine 2";TYPE=HOME:;;Sub St;Town;;;US',
      "EMAIL:t@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].addresses?.a0?.fullAddress).toBe("Line 1\nLine 2");
    expect(result[0].addresses?.a0?.contexts).toEqual({ private: true });
  });

  it("survives quoted parameter values containing semicolons", () => {
    // Without quote-aware param splitting, the ; inside LABEL would shred
    // the param list and the ADR would lose its TYPE.
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Lev",
      'ADR;LABEL="Building A; Suite 12";TYPE=WORK:;;1 Plaza;NYC;NY;10001;US',
      "EMAIL:lev@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].addresses?.a0?.fullAddress).toBe("Building A; Suite 12");
    expect(result[0].addresses?.a0?.contexts).toEqual({ work: true });
    expect(result[0].addresses?.a0?.locality).toBe("NYC");
  });

  it("parses BIRTHPLACE and DEATHPLACE (RFC 6474)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Marie Curie",
      "BDAY:18671107",
      "BIRTHPLACE:Warsaw\\, Poland",
      "DEATHDATE:19340704",
      "DEATHPLACE:Passy\\, France",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    const annivs = Object.values(result[0].anniversaries || {});
    const birth = annivs.find((a) => a.kind === "birth");
    const death = annivs.find((a) => a.kind === "death");
    expect(birth?.place?.fullAddress).toBe("Warsaw, Poland");
    expect(death?.place?.fullAddress).toBe("Passy, France");
  });

  it("parses EXPERTISE / HOBBY / INTEREST with LEVEL (RFC 6715)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Polymath",
      "EXPERTISE;LEVEL=expert:cryptography",
      "EXPERTISE;LEVEL=beginner:welding",
      "HOBBY;LEVEL=high:gardening",
      "INTEREST;LEVEL=medium:opera",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    const info = Object.values(result[0].personalInfo || {});
    expect(info).toEqual(expect.arrayContaining([
      { kind: "expertise", value: "cryptography", level: "high" },
      { kind: "expertise", value: "welding", level: "low" },
      { kind: "hobby", value: "gardening", level: "high" },
      { kind: "interest", value: "opera", level: "medium" },
    ]));
  });

  it("parses ORG-DIRECTORY (RFC 6715) and CONTACT-URI (RFC 8605)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Corp Person",
      "ORG-DIRECTORY:https://example.com/staff/",
      "CONTACT-URI;PREF=1:https://example.com/contact",
      "EMAIL:c@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(Object.values(result[0].directories || {})[0]).toMatchObject({
      uri: "https://example.com/staff/",
      kind: "directory",
    });
    const links = Object.values(result[0].links || {});
    expect(links[0]).toMatchObject({
      uri: "https://example.com/contact",
      kind: "contact",
      pref: 1,
    });
  });

  it("parses RFC 9554 CREATED, GRAMGENDER, PRONOUNS", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Modern Person",
      "CREATED:20250101T120000Z",
      "GRAMGENDER:neuter",
      "PRONOUNS:they/them",
      "PRONOUNS;PREF=2:ze/zir",
      "EMAIL:m@example.com",
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    expect(result[0].created).toBe("20250101T120000Z");
    expect(result[0].speakToAs?.grammaticalGender).toBe("neuter");
    const pronouns = Object.values(result[0].speakToAs?.pronouns || {});
    expect(pronouns).toEqual(expect.arrayContaining([
      expect.objectContaining({ pronouns: "they/them" }),
      expect.objectContaining({ pronouns: "ze/zir", pref: 2 }),
    ]));
  });

  it("accepts vCard 4.0 KIND values (location, device, application)", () => {
    for (const k of ["location", "device", "application"] as const) {
      const vcf = [
        "BEGIN:VCARD",
        "VERSION:4.0",
        `KIND:${k}`,
        "FN:Thing",
        "END:VCARD",
      ].join("\r\n");
      expect(parseVCard(vcf)[0].kind).toBe(k);
    }
  });

  it("handles ADR with LABEL/GEO/TZ/CC parameters (RFC 9554)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:GeoPerson",
      'ADR;CC=DE;GEO="geo:52.5,13.4";TZ=Europe/Berlin;LABEL="Unter den Linden 1\\nBerlin":;;Unter den Linden 1;Berlin;;10117;Germany',
      "END:VCARD",
    ].join("\r\n");

    const result = parseVCard(vcf);
    const addr = result[0].addresses?.a0;
    expect(addr?.countryCode).toBe("DE");
    expect(addr?.coordinates).toBe("52.5,13.4");
    expect(addr?.timeZone).toBe("Europe/Berlin");
    expect(addr?.fullAddress).toContain("Unter den Linden 1");
    expect(addr?.locality).toBe("Berlin");
  });

  it("unfolds LF-only continuation lines (no CR)", () => {
    // Unix exporters often use LF only; we must still unfold.
    const vcf = "BEGIN:VCARD\nVERSION:4.0\nFN:John\n Doe\nEMAIL:j@d.com\nEND:VCARD";
    const result = parseVCard(vcf);
    expect(result[0].name?.components).toEqual(
      expect.arrayContaining([{ kind: "given", value: "JohnDoe" }])
    );
  });

  it("round-trips vCard 4.0-only properties through generateVCard", () => {
    const original = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Round Trip",
      "EMAIL;PREF=1:rt@example.com",
      "BDAY:19700101",
      "BIRTHPLACE:Somewhere",
      "EXPERTISE;LEVEL=expert:vCard",
      "HOBBY;LEVEL=medium:reading",
      "ORG-DIRECTORY:https://example.com/dir",
      "CONTACT-URI:https://example.com/contact",
      "CREATED:20240101T000000Z",
      "END:VCARD",
    ].join("\r\n");

    const exported = generateVCard(parseVCard(original));
    const reparsed = parseVCard(exported)[0];

    expect(reparsed.emails?.e0?.pref).toBe(1);
    expect(Object.values(reparsed.anniversaries || {}).find(a => a.kind === "birth")?.place?.fullAddress).toBe("Somewhere");
    const info = Object.values(reparsed.personalInfo || {});
    expect(info).toEqual(expect.arrayContaining([
      { kind: "expertise", value: "vCard", level: "high" },
      { kind: "hobby", value: "reading", level: "medium" },
    ]));
    expect(Object.values(reparsed.directories || {})[0]?.uri).toBe("https://example.com/dir");
    expect(Object.values(reparsed.links || {})[0]).toMatchObject({
      uri: "https://example.com/contact",
      kind: "contact",
    });
    expect(reparsed.created).toBe("20240101T000000Z");
  });
});

describe("anniversary dates (issue #224)", () => {
  const parseOne = (...props: string[]) =>
    parseVCard(["BEGIN:VCARD", "VERSION:4.0", "FN:Test Person", ...props, "END:VCARD"].join("\r\n"))[0];

  it("parses BDAY into a structured PartialDate, not a raw string", () => {
    // JSContact rejects a string date, which is why imported birthdays used
    // to disappear once they reached the server.
    const card = parseOne("BDAY:19850412");
    const birth = Object.values(card.anniversaries || {}).find(a => a.kind === "birth");
    expect(birth?.date).toEqual({ year: 1985, month: 4, day: 12 });
  });

  it.each([
    ["BDAY:1985-04-12", { year: 1985, month: 4, day: 12 }],
    ["BDAY:19850412T232050Z", { year: 1985, month: 4, day: 12 }],
    ["BDAY:1985-04-12T00:00:00Z", { year: 1985, month: 4, day: 12 }],
    ["BDAY:--0412", { month: 4, day: 12 }],
    ["BDAY:--04-12", { month: 4, day: 12 }],
    ["BDAY:--04", { month: 4 }],
    ["BDAY:---12", { day: 12 }],
    ["BDAY:1985-04", { year: 1985, month: 4 }],
    ["BDAY:1985", { year: 1985 }],
  ])("parses %s", (prop, expected) => {
    const card = parseOne(prop);
    expect(Object.values(card.anniversaries || {})[0]?.date).toEqual(expected);
  });

  it.each([
    "BDAY;VALUE=text:circa 1800",
    "BDAY:not-a-date",
    "BDAY:1985-13-01",
    "BDAY:",
  ])("drops the unrepresentable date in %s", (prop) => {
    expect(parseOne(prop).anniversaries).toBeUndefined();
  });

  it("keeps BDAY and ANNIVERSARY side by side instead of overwriting", () => {
    const card = parseOne("ANNIVERSARY:20100601", "BDAY:19850412");
    const kinds = Object.values(card.anniversaries || {}).map(a => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["wedding", "birth"]));
    expect(Object.keys(card.anniversaries || {})).toHaveLength(2);
  });

  it("round-trips a birthday through generateVCard", () => {
    const exported = generateVCard([parseOne("BDAY:19850412")]);
    expect(exported).toContain("BDAY:1985-04-12");
    const reparsed = parseVCard(exported)[0];
    expect(Object.values(reparsed.anniversaries || {})[0]?.date).toEqual({
      year: 1985, month: 4, day: 12,
    });
  });

  it("round-trips a day/month-only birthday", () => {
    const exported = generateVCard([parseOne("BDAY:--0412")]);
    expect(exported).toContain("BDAY:--04-12");
    expect(Object.values(parseVCard(exported)[0].anniversaries || {})[0]?.date)
      .toEqual({ month: 4, day: 12 });
  });
});

describe("vendor extensions (issue #224)", () => {
  const parseOne = (...props: string[]) =>
    parseVCard(["BEGIN:VCARD", "VERSION:3.0", "FN:Test Person", ...props, "END:VCARD"].join("\r\n"))[0];

  it("imports X-ANDROID-CUSTOM nicknames", () => {
    const card = parseOne("X-ANDROID-CUSTOM:vnd.android.cursor.item/nickname;Bobby;1;;;;;;;;;;;;;");
    expect(Object.values(card.nicknames || {})).toEqual([{ name: "Bobby" }]);
  });

  it("imports X-ANDROID-CUSTOM contact events as anniversaries", () => {
    const card = parseOne(
      "X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;1985-04-12;3;;;;;;;;;;;;;",
      "X-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2010-06-01;1;;;;;;;;;;;;;",
    );
    expect(Object.values(card.anniversaries || {})).toEqual([
      { kind: "birth", date: { year: 1985, month: 4, day: 12 } },
      { kind: "wedding", date: { year: 2010, month: 6, day: 1 } },
    ]);
  });

  it("imports X-ANDROID-CUSTOM relations", () => {
    const card = parseOne("X-ANDROID-CUSTOM:vnd.android.cursor.item/relation;Jane Doe;14;;;;;;;;;;;;;");
    expect(card.relatedTo?.["Jane Doe"]).toEqual({ relation: { spouse: true } });
  });

  it("imports Apple grouped X-ABDATE with its X-ABLABEL", () => {
    const card = parseOne(
      "item1.X-ABDATE:2010-06-01",
      "item1.X-ABLABEL:_$!<Anniversary>!$_",
      "item2.X-ABDATE:2015-09-20",
      "item2.X-ABLABEL:First day at work",
    );
    expect(Object.values(card.anniversaries || {})).toEqual([
      { kind: "wedding", date: { year: 2010, month: 6, day: 1 } },
      { kind: "other", date: { year: 2015, month: 9, day: 20 } },
    ]);
  });

  it("applies a grouped X-ABLABEL to the property it labels", () => {
    const card = parseOne(
      "item1.TEL;TYPE=VOICE:+1-555-0100",
      "item1.X-ABLABEL:Ski cabin",
      "item2.EMAIL:side@example.com",
      "item2.X-ABLABEL:_$!<Other>!$_",
    );
    expect(card.phones?.p0?.label).toBe("Ski cabin");
    expect(card.emails?.e0?.label).toBe("Other");
  });

  it("imports X-ABRELATEDNAMES and X-SPOUSE as relations", () => {
    const card = parseOne(
      "item1.X-ABRELATEDNAMES:Sam Smith",
      "item1.X-ABLABEL:_$!<Brother>!$_",
      "X-SPOUSE:Alex Smith",
    );
    expect(card.relatedTo?.["Sam Smith"]).toEqual({ relation: { sibling: true } });
    expect(card.relatedTo?.["Alex Smith"]).toEqual({ relation: { spouse: true } });
  });

  it("imports X- instant-messaging handles as online services", () => {
    const card = parseOne("X-SKYPE-USERNAME:jdoe", "X-TWITTER:https://twitter.com/jdoe");
    const services = Object.values(card.onlineServices || {});
    expect(services).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: "Skype", uri: "jdoe", user: "jdoe" }),
      expect.objectContaining({ service: "Twitter", uri: "https://twitter.com/jdoe" }),
    ]));
    expect(services.find(s => s.service === "Twitter")?.user).toBeUndefined();
  });

  it("imports X-GENDER and round-trips X-MAIDENNAME", () => {
    const card = parseOne("N:Smith;Jane;;;", "X-GENDER:Female", "X-MAIDENNAME:Brown");
    expect(card.speakToAs?.grammaticalGender).toBe("feminine");
    expect(card.name?.components).toEqual(
      expect.arrayContaining([{ kind: "surname2", value: "Brown" }])
    );

    const reparsed = parseVCard(generateVCard([card]))[0];
    expect(reparsed.name?.components).toEqual(
      expect.arrayContaining([{ kind: "surname2", value: "Brown" }])
    );
  });

  it("leaves unknown X- properties alone", () => {
    const card = parseOne("X-SOMETHING-ELSE:whatever");
    expect(card.onlineServices).toBeUndefined();
    expect(card.notes).toBeUndefined();
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
