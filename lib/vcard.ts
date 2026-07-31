import type { ContactCard, NameComponent, ContactOnlineService, AnniversaryDate, PartialDate } from "@/lib/jmap/types";
import { generateUUID } from "@/lib/utils";

// Convert RFC 9553 AnniversaryDate (PartialDate|Timestamp|string) to vCard date string
function anniversaryDateToVcardString(date: AnniversaryDate): string {
  if (typeof date === 'string') return date;
  if (date && typeof date === 'object') {
    if ('@type' in date && date['@type'] === 'Timestamp' && 'utc' in date) {
      return (date as { utc: string }).utc.split('T')[0];
    }
    const pd = date as PartialDate;
    if (pd.year && pd.month && pd.day) {
      return `${String(pd.year).padStart(4, '0')}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
    }
    if (pd.month && pd.day) {
      return `--${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
    }
    if (pd.year && pd.month) {
      return `${String(pd.year).padStart(4, '0')}-${String(pd.month).padStart(2, '0')}`;
    }
    if (pd.year) return String(pd.year);
  }
  return String(date);
}

const VCARD_SEX_TO_GENDER: Record<string, string> = {
  M: "masculine",
  F: "feminine",
  O: "other",
  N: "none",
  U: "unknown",
};

const GENDER_TO_VCARD_SEX: Record<string, string> = {
  masculine: "M",
  feminine: "F",
  other: "O",
  none: "N",
  unknown: "U",
};

function vcardSexToGrammaticalGender(sex: string): string {
  return VCARD_SEX_TO_GENDER[sex.toUpperCase()] || sex.toLowerCase();
}

function grammaticalGenderToVcardSex(gender: string): string {
  return GENDER_TO_VCARD_SEX[gender.toLowerCase()] || "";
}

function unfoldLines(vcf: string): string {
  // Normalize line endings first, then unfold continuation lines (RFC 6350 §3.2).
  // Continuation lines start with a single SPACE or TAB; we must handle both
  // CRLF (RFC-canonical) and LF-only files (common from Unix exporters).
  return vcf
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
}

// RFC 6868 parameter value encoding - used inside parameter values only.
// Caret-encoded sequences: ^n → LF, ^^ → ^, ^' → DQUOTE.
function decodeParamValue(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "^" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n") { out += "\n"; i++; continue; }
      if (next === "^") { out += "^"; i++; continue; }
      if (next === "'") { out += '"'; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

// Split on delim, respecting DQUOTE-quoted spans (RFC 6350 §3.3 / §5).
function splitRespectingQuotes(s: string, delim: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === delim && !inQuote) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// Find the first ":" outside of a DQUOTE-quoted parameter value.
// Returns -1 when none. Needed because property params may carry quoted
// values that contain colons (e.g. ADR;LABEL="Suite 100:..." or X- params).
function findValueColon(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ":" && !inQuote) return i;
  }
  return -1;
}

// vCard properties may carry a group prefix: "item1.EMAIL:foo@bar".
// Strip the prefix and return the bare property name + params component.
function stripGroupPrefix(keyPart: string): string {
  const dot = keyPart.indexOf(".");
  if (dot < 0) return keyPart;
  const before = keyPart.substring(0, dot);
  // Only treat as group if the segment before the dot has no ";" (which would
  // indicate it's actually a param boundary) and matches the RFC 6350 group
  // grammar (ALPHA / DIGIT / "-").
  if (before.includes(";")) return keyPart;
  if (!/^[A-Za-z0-9-]+$/.test(before)) return keyPart;
  return keyPart.substring(dot + 1);
}

// Strip URI scheme prefix from a value (e.g. "tel:+1-555" → "+1-555").
function stripUriScheme(val: string, scheme: string): string {
  const prefix = `${scheme}:`;
  if (val.toLowerCase().startsWith(prefix)) return val.substring(prefix.length);
  return val;
}

function parsePrefParam(params: Record<string, string>): number | undefined {
  if (params.PREF) {
    const n = parseInt(params.PREF, 10);
    if (!Number.isNaN(n)) return n;
  }
  // vCard 3.0 style: TYPE=PREF (no numeric value)
  if (params.TYPE && /\bPREF\b/i.test(params.TYPE)) return 1;
  return undefined;
}

// vCard 2.1 quoted-printable soft line breaks: a line ending in `=` continues
// onto the next line. This is distinct from RFC 5545/6350 line folding (which
// uses leading whitespace and is already handled in unfoldLines). Only merge
// when the originating line declares ENCODING=QUOTED-PRINTABLE so we don't
// accidentally splice unrelated lines.
function joinQpSoftBreaks(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (/;ENCODING=QUOTED-PRINTABLE/i.test(line)) {
      while (line.endsWith("=") && i + 1 < lines.length) {
        i++;
        line = line.slice(0, -1) + lines[i];
      }
    }
    result.push(line);
    i++;
  }
  return result;
}

function decodeQuotedPrintable(input: string, charset?: string): string {
  const cleaned = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === "=" && i + 2 < cleaned.length) {
      const hex = cleaned.substring(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    bytes.push(cleaned.charCodeAt(i) & 0xff);
    i += 1;
  }
  const label = (charset || "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

function decodeValue(raw: string): string {
  return raw
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function encodeValue(val: string): string {
  return val
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function parseParams(paramStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!paramStr) return params;
  const parts = splitRespectingQuotes(paramStr, ";");
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq > 0) {
      const name = part.substring(0, eq).toUpperCase();
      // Strip surrounding quotes then RFC 6868 caret-decode.
      // Strip surrounding DQUOTE if present (RFC 6350 §3.3). Pre-decode there
      // are no literal LFs in a parameter value (those arrive as "^n" via
      // RFC 6868), so we don't need the dotAll flag.
      const rawVal = part.substring(eq + 1).replace(/^"(.*)"$/, "$1");
      params[name] = decodeParamValue(rawVal);
    } else {
      const upper = part.toUpperCase();
      if (upper === "QUOTED-PRINTABLE" || upper === "BASE64") {
        params.ENCODING = upper;
      } else if (["WORK", "HOME", "CELL", "FAX", "VOICE", "PREF", "PAGER", "VIDEO", "TEXT", "TEXTPHONE"].includes(upper)) {
        params.TYPE = params.TYPE ? `${params.TYPE},${upper}` : upper;
      }
    }
  }
  return params;
}

const PHONE_FEATURE_TYPES = new Set(["CELL", "FAX", "VOICE", "PAGER", "VIDEO", "TEXT", "TEXTPHONE"]);

function typeToPhoneFeatures(typeStr: string | undefined): Record<string, boolean> | undefined {
  if (!typeStr) return undefined;
  const types = typeStr.toUpperCase().split(",");
  const features: Record<string, boolean> = {};
  for (const t of types) {
    if (PHONE_FEATURE_TYPES.has(t)) {
      features[t.toLowerCase()] = true;
    }
  }
  return Object.keys(features).length > 0 ? features : undefined;
}

function typeToContext(typeStr: string | undefined): Record<string, boolean> | undefined {
  if (!typeStr) return undefined;
  const types = typeStr.toUpperCase().split(",");
  const ctx: Record<string, boolean> = {};
  if (types.includes("WORK")) ctx.work = true;
  if (types.includes("HOME")) ctx.private = true;
  if (!ctx.work && !ctx.private) return undefined;
  return ctx;
}

function contextToType(contexts: Record<string, boolean> | undefined): string {
  if (!contexts) return "";
  if (contexts.work) return "WORK";
  if (contexts.private) return "HOME";
  return "";
}

export function parseVCard(vcfString: string): ContactCard[] {
  const text = unfoldLines(vcfString);
  const lines = joinQpSoftBreaks(text.split("\n"));
  const contacts: ContactCard[] = [];
  let current: Record<string, string[]> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.toUpperCase() === "BEGIN:VCARD") {
      current = {};
      continue;
    }

    if (trimmed.toUpperCase() === "END:VCARD") {
      if (current) {
        const card = buildContact(current);
        if (card) contacts.push(card);
      }
      current = null;
      continue;
    }

    if (current) {
      const colonIdx = findValueColon(trimmed);
      if (colonIdx < 1) continue;
      const keyPart = stripGroupPrefix(trimmed.substring(0, colonIdx));
      const value = trimmed.substring(colonIdx + 1);
      if (!current[keyPart]) current[keyPart] = [];
      current[keyPart].push(value);
    }
  }

  return contacts;
}

function buildContact(raw: Record<string, string[]>): ContactCard | null {
  const id = `import-${generateUUID()}`;
  const card: ContactCard = { id, addressBookIds: {} };
  // Deferred BIRTHPLACE/DEATHPLACE values - attach to anniversary at end,
  // because the BDAY/DEATHDATE entry may appear in any order.
  let birthPlace: string | undefined;
  let deathPlace: string | undefined;

  for (const [fullKey, values] of Object.entries(raw)) {
    // splitRespectingQuotes so a quoted param value containing ";" survives.
    const segments = splitRespectingQuotes(fullKey, ";");
    const propName = (segments.shift() || "").toUpperCase();
    const paramStr = segments.join(";");
    const params = parseParams(paramStr);
    const pref = parsePrefParam(params);

    const isQuotedPrintable = params.ENCODING?.toUpperCase() === "QUOTED-PRINTABLE";

    for (const rawValue of values) {
      const decoded = isQuotedPrintable
        ? decodeQuotedPrintable(rawValue, params.CHARSET)
        : rawValue;
      const val = decodeValue(decoded);

      switch (propName) {
        case "FN":
          if (!card.name) {
            const parts = val.split(" ");
            const components: NameComponent[] = [];
            if (parts.length >= 2) {
              components.push({ kind: "given", value: parts[0] });
              components.push({ kind: "surname", value: parts.slice(1).join(" ") });
            } else if (parts.length === 1) {
              components.push({ kind: "given", value: parts[0] });
            }
            card.name = { components, isOrdered: true };
          }
          break;

        case "N": {
          // vCard N: family;given;additional;prefix;suffix  (RFC 6350 §6.2.2)
          // Mapped to JSContact-standard kinds (RFC 9553 §2.2.1):
          //   prefix→title, additional→given2, suffix→generation.
          // Pushed in natural display order so `isOrdered: true` renders correctly.
          const nParts = val.split(";");
          const components: NameComponent[] = [];
          if (nParts[3]) components.push({ kind: "title", value: nParts[3] });
          if (nParts[1]) components.push({ kind: "given", value: nParts[1] });
          if (nParts[2]) components.push({ kind: "given2", value: nParts[2] });
          if (nParts[0]) components.push({ kind: "surname", value: nParts[0] });
          if (nParts[4]) components.push({ kind: "generation", value: nParts[4] });
          if (components.length > 0) {
            card.name = { components, isOrdered: true };
          }
          break;
        }

        case "EMAIL": {
          if (!card.emails) card.emails = {};
          const idx = Object.keys(card.emails).length;
          card.emails[`e${idx}`] = {
            address: stripUriScheme(val, "mailto"),
            contexts: typeToContext(params.TYPE),
            label: params["X-ABLABEL"] || undefined,
            pref,
          };
          break;
        }

        case "TEL": {
          if (!card.phones) card.phones = {};
          const idx = Object.keys(card.phones).length;
          card.phones[`p${idx}`] = {
            // vCard 4.0 TEL is a URI value (RFC 6350 §6.4.1); strip the
            // "tel:" scheme for storage as a bare number.
            number: stripUriScheme(val, "tel"),
            contexts: typeToContext(params.TYPE),
            features: typeToPhoneFeatures(params.TYPE),
            label: params["X-ABLABEL"] || undefined,
            pref,
          };
          break;
        }

        case "ORG": {
          if (!card.organizations) card.organizations = {};
          const orgParts = val.split(";").filter(Boolean);
          const idx = Object.keys(card.organizations).length;
          card.organizations[`o${idx}`] = {
            name: orgParts[0],
            units: orgParts.slice(1).map(u => ({ name: u })),
          };
          break;
        }

        case "ADR": {
          if (!card.addresses) card.addresses = {};
          const adrParts = val.split(";");
          const idx = Object.keys(card.addresses).length;
          card.addresses[`a${idx}`] = {
            street: adrParts[2] || undefined,
            locality: adrParts[3] || undefined,
            region: adrParts[4] || undefined,
            postcode: adrParts[5] || undefined,
            country: adrParts[6] || undefined,
            // vCard 4.0 (RFC 9554 §3.2): CC param carries ISO country code,
            // and LABEL/GEO/TZ params attach directly to the ADR.
            countryCode: params.CC || undefined,
            fullAddress: params.LABEL || undefined,
            coordinates: params.GEO ? stripUriScheme(params.GEO, "geo") : undefined,
            timeZone: params.TZ || undefined,
            contexts: typeToContext(params.TYPE),
            label: params["X-ABLABEL"] || undefined,
            pref,
          };
          break;
        }

        case "NOTE": {
          if (!card.notes) card.notes = {};
          const idx = Object.keys(card.notes).length;
          card.notes[`n${idx}`] = { note: val };
          break;
        }

        case "NICKNAME": {
          if (!card.nicknames) card.nicknames = {};
          card.nicknames.n0 = { name: val };
          break;
        }

        case "UID":
          card.uid = val;
          break;

        case "KIND": {
          // RFC 6350 §6.1.4 plus RFC 6473 (application).
          const k = val.toLowerCase();
          if (k === "group" || k === "individual" || k === "org" ||
              k === "location" || k === "device" || k === "application") {
            card.kind = k;
          }
          break;
        }

        case "MEMBER": {
          if (!card.members) card.members = {};
          const memberUri = val.startsWith("urn:uuid:") ? val.substring(9) : val;
          card.members[memberUri] = true;
          break;
        }

        case "PHOTO": {
          if (!card.media) card.media = {};
          const idx = Object.keys(card.media).length;
          const encoding = params.ENCODING?.toUpperCase();
          // vCard 4.0 uses MEDIATYPE; 3.0 reuses TYPE for the image kind.
          const mediaType = params.MEDIATYPE || (params.TYPE && params.TYPE.includes("/") ? params.TYPE : (params.TYPE && /^(JPEG|JPG|PNG|GIF|WEBP|HEIC|BMP|SVG)$/i.test(params.TYPE) ? params.TYPE : "")) || "";
          if (encoding === "B" || encoding === "BASE64") {
            // Inline base64 photo - construct a data URI
            const mime = mediaType.includes("/") ? mediaType : mediaType ? `image/${mediaType.toLowerCase()}` : "image/jpeg";
            card.media[`m${idx}`] = {
              kind: "photo",
              uri: `data:${mime};base64,${rawValue}`,
              mediaType: mime,
            };
          } else if (val.startsWith("data:") || val.startsWith("http://") || val.startsWith("https://")) {
            // vCard 4.0 URI value (data URI or URL) - no ENCODING param.
            card.media[`m${idx}`] = {
              kind: "photo",
              uri: val,
              mediaType: mediaType.includes("/") ? mediaType : undefined,
            };
          }
          break;
        }

        case "TITLE": {
          if (!card.titles) card.titles = {};
          const idx = Object.keys(card.titles).length;
          card.titles[`t${idx}`] = { name: val, kind: "title" };
          break;
        }

        case "ROLE": {
          if (!card.titles) card.titles = {};
          const idx = Object.keys(card.titles).length;
          card.titles[`t${idx}`] = { name: val, kind: "role" };
          break;
        }

        case "URL": {
          if (!card.onlineServices) card.onlineServices = {};
          const idx = Object.keys(card.onlineServices).length;
          card.onlineServices[`u${idx}`] = {
            uri: val,
            contexts: typeToContext(params.TYPE),
            label: params["X-ABLABEL"] ||
              (params.TYPE?.toLowerCase() === "home" || params.TYPE?.toLowerCase() === "work" ? undefined : params.TYPE),
            pref,
          };
          break;
        }

        case "IMPP":
        case "X-SOCIALPROFILE":
        case "SOCIALPROFILE": {
          // RFC 9554 §3.7 introduces SOCIALPROFILE; treat the same as IMPP/X-SOCIALPROFILE.
          if (!card.onlineServices) card.onlineServices = {};
          const idx = Object.keys(card.onlineServices).length;
          const svc: ContactOnlineService = {
            uri: val,
            contexts: typeToContext(params.TYPE),
            pref,
          };
          if (params["X-SERVICE-TYPE"]) {
            svc.service = params["X-SERVICE-TYPE"];
          } else if (params.SERVICE) {
            svc.service = params.SERVICE;
          } else if ((propName === "X-SOCIALPROFILE" || propName === "SOCIALPROFILE") && params.TYPE) {
            const typeVal = params.TYPE.toLowerCase();
            if (typeVal !== "work" && typeVal !== "home") {
              svc.service = params.TYPE;
            }
          }
          if (params["X-USER"]) svc.user = params["X-USER"];
          if (params["X-ABLABEL"]) svc.label = params["X-ABLABEL"];
          card.onlineServices[`u${idx}`] = svc;
          break;
        }

        case "BDAY": {
          if (!card.anniversaries) card.anniversaries = {};
          card.anniversaries.a0 = { kind: "birth", date: val };
          break;
        }

        case "BIRTHPLACE": {
          // RFC 6474 §2.1. Stash the location and attach to the birth
          // anniversary at the end of buildContact, since BDAY may appear
          // either before or after BIRTHPLACE in the vCard.
          birthPlace = val;
          break;
        }

        case "ANNIVERSARY":
        case "X-ANNIVERSARY": {
          if (!card.anniversaries) card.anniversaries = {};
          const idx = Object.keys(card.anniversaries).length;
          card.anniversaries[`a${idx}`] = { kind: "wedding", date: val };
          break;
        }

        case "DEATHDATE":
        case "X-DEATHDATE": {
          if (!card.anniversaries) card.anniversaries = {};
          const idx = Object.keys(card.anniversaries).length;
          card.anniversaries[`a${idx}`] = { kind: "death", date: val };
          break;
        }

        case "DEATHPLACE": {
          // RFC 6474 §2.2.
          deathPlace = val;
          break;
        }

        case "CATEGORIES": {
          if (!card.keywords) card.keywords = {};
          const cats = val.split(",").map(c => c.trim()).filter(Boolean);
          for (const cat of cats) {
            card.keywords[cat] = true;
          }
          break;
        }

        case "KEY": {
          if (!card.cryptoKeys) card.cryptoKeys = {};
          const idx = Object.keys(card.cryptoKeys).length;
          card.cryptoKeys[`k${idx}`] = {
            uri: val,
            mediaType: params.MEDIATYPE || (params.TYPE && params.TYPE.includes("/") ? params.TYPE : undefined),
            contexts: typeToContext(params.TYPE),
          };
          break;
        }

        case "RELATED": {
          if (!card.relatedTo) card.relatedTo = {};
          // RFC 6350 §6.6.6: TYPE may be a comma-separated list (or
          // multi-valued via repeated params); convert to relation map.
          const relation: Record<string, boolean> = {};
          if (params.TYPE) {
            for (const t of params.TYPE.split(",")) {
              const norm = t.trim().toLowerCase();
              if (norm) relation[norm] = true;
            }
          }
          card.relatedTo[val] = { relation: Object.keys(relation).length > 0 ? relation : undefined };
          break;
        }

        case "LANG": {
          if (!card.preferredLanguages) card.preferredLanguages = {};
          const idx = Object.keys(card.preferredLanguages).length;
          card.preferredLanguages[`l${idx}`] = {
            language: val,
            contexts: typeToContext(params.TYPE),
            pref,
          };
          break;
        }

        case "PRODID":
          card.prodId = val;
          break;

        case "REV":
          card.updated = val;
          break;

        case "GEO": {
          // Store GEO as coordinates on the first address, or create one
          if (!card.addresses) card.addresses = {};
          if (Object.keys(card.addresses).length === 0) {
            card.addresses.a0 = { coordinates: val };
          } else {
            const firstKey = Object.keys(card.addresses)[0];
            card.addresses[firstKey].coordinates = val;
          }
          break;
        }

        case "TZ": {
          if (!card.addresses) card.addresses = {};
          if (Object.keys(card.addresses).length === 0) {
            card.addresses.a0 = { timeZone: val };
          } else {
            const firstKey = Object.keys(card.addresses)[0];
            card.addresses[firstKey].timeZone = val;
          }
          break;
        }

        case "GENDER": {
          // vCard 4.0 §6.2.7: sex-component[;identity-component]. We map the
          // sex letter to JSContact's grammaticalGender and stuff the free-
          // form identity into pronouns (a coarse approximation; RFC 9554's
          // PRONOUNS / GRAMGENDER, handled below, are preferred when present).
          const gParts = val.split(";");
          const sexCode = gParts[0]?.toUpperCase();
          const identityText = gParts[1];
          if (sexCode || identityText) {
            if (!card.speakToAs) card.speakToAs = {};
            if (sexCode) {
              card.speakToAs.grammaticalGender = vcardSexToGrammaticalGender(sexCode);
            }
            if (identityText) {
              if (!card.speakToAs.pronouns) card.speakToAs.pronouns = {};
              const pkey = `p${Object.keys(card.speakToAs.pronouns).length}`;
              card.speakToAs.pronouns[pkey] = { pronouns: identityText };
            }
          }
          break;
        }

        case "LOGO": {
          if (!card.media) card.media = {};
          const idx = Object.keys(card.media).length;
          const encoding = params.ENCODING?.toUpperCase();
          // Prefer MEDIATYPE (vCard 4.0); fall back to TYPE only when it's a
          // MIME type or a known image format token (vCard 3.0 idiom).
          const mediaType = params.MEDIATYPE || (params.TYPE && (params.TYPE.includes("/") || /^(JPEG|JPG|PNG|GIF|WEBP|SVG)$/i.test(params.TYPE)) ? params.TYPE : "");
          if (encoding === "B" || encoding === "BASE64") {
            const mime = mediaType.includes("/") ? mediaType : mediaType ? `image/${mediaType.toLowerCase()}` : "image/png";
            card.media[`m${idx}`] = {
              kind: "logo",
              uri: `data:${mime};base64,${rawValue}`,
              mediaType: mime,
            };
          } else if (val.startsWith("data:") || val.startsWith("http://") || val.startsWith("https://")) {
            card.media[`m${idx}`] = {
              kind: "logo",
              uri: val,
              mediaType: mediaType.includes("/") ? mediaType : undefined,
            };
          }
          break;
        }

        case "SOUND": {
          if (!card.media) card.media = {};
          const idx = Object.keys(card.media).length;
          const encoding = params.ENCODING?.toUpperCase();
          const mediaType = params.MEDIATYPE || (params.TYPE && (params.TYPE.includes("/") || /^(OGG|MP3|WAV|AAC|FLAC)$/i.test(params.TYPE)) ? params.TYPE : "");
          if (encoding === "B" || encoding === "BASE64") {
            const mime = mediaType.includes("/") ? mediaType : mediaType ? `audio/${mediaType.toLowerCase()}` : "audio/ogg";
            card.media[`m${idx}`] = {
              kind: "sound",
              uri: `data:${mime};base64,${rawValue}`,
              mediaType: mime,
            };
          } else if (val.startsWith("data:") || val.startsWith("http://") || val.startsWith("https://")) {
            card.media[`m${idx}`] = {
              kind: "sound",
              uri: val,
              mediaType: mediaType.includes("/") ? mediaType : undefined,
            };
          }
          break;
        }

        case "LABEL": {
          // Mailing label (v2.1/3.0) - store as fullAddress on last/new address
          if (!card.addresses) card.addresses = {};
          const addrKeys = Object.keys(card.addresses);
          if (addrKeys.length > 0) {
            const lastKey = addrKeys[addrKeys.length - 1];
            card.addresses[lastKey].fullAddress = val;
          } else {
            card.addresses.a0 = { fullAddress: val, contexts: typeToContext(params.TYPE) };
          }
          break;
        }

        case "CALURI":
          card.calendarUri = val;
          break;

        case "CALADRURI":
          card.schedulingUri = val;
          break;

        case "FBURL":
          card.freeBusyUri = val;
          break;

        case "SOURCE":
          card.source = val;
          break;

        // ---- RFC 6715 (EXPERTISE / HOBBY / INTEREST / ORG-DIRECTORY) ----
        case "EXPERTISE":
        case "HOBBY":
        case "INTEREST": {
          if (!card.personalInfo) card.personalInfo = {};
          const idx = Object.keys(card.personalInfo).length;
          const kind = propName.toLowerCase() as "expertise" | "hobby" | "interest";
          const rawLevel = params.LEVEL?.toLowerCase();
          // RFC 6715 levels: expertise uses beginner/average/expert; hobby/
          // interest use high/medium/low. Normalize all into JSContact's
          // high/medium/low triplet.
          const levelMap: Record<string, "high" | "medium" | "low"> = {
            beginner: "low", average: "medium", expert: "high",
            low: "low", medium: "medium", high: "high",
          };
          const level = rawLevel ? levelMap[rawLevel] : undefined;
          card.personalInfo[`i${idx}`] = { kind, value: val, level };
          break;
        }

        case "ORG-DIRECTORY": {
          // RFC 6715 §2.4 - directory URI for the contact's organization.
          if (!card.directories) card.directories = {};
          const idx = Object.keys(card.directories).length;
          card.directories[`d${idx}`] = {
            uri: val,
            kind: "directory",
            mediaType: params.MEDIATYPE || undefined,
          };
          break;
        }

        // ---- RFC 8605 (CONTACT-URI) ----
        case "CONTACT-URI": {
          if (!card.links) card.links = {};
          const idx = Object.keys(card.links).length;
          card.links[`l${idx}`] = {
            uri: val,
            kind: "contact",
            pref,
          };
          break;
        }

        // ---- RFC 9554 vCard 4.0 extensions ----
        case "CREATED":
          card.created = val;
          break;

        case "GRAMGENDER": {
          // RFC 9554 §3.4 - grammatical gender (animate/common/feminine/masculine/neuter).
          if (!card.speakToAs) card.speakToAs = {};
          card.speakToAs.grammaticalGender = val.toLowerCase();
          break;
        }

        case "PRONOUNS": {
          // RFC 9554 §3.5 - free-form pronouns. May appear multiple times.
          if (!card.speakToAs) card.speakToAs = {};
          if (!card.speakToAs.pronouns) card.speakToAs.pronouns = {};
          const pkey = `p${Object.keys(card.speakToAs.pronouns).length}`;
          card.speakToAs.pronouns[pkey] = {
            pronouns: val,
            pref,
            contexts: typeToContext(params.TYPE),
          };
          break;
        }

        // Silently swallow purely structural / sync metadata properties so
        // they don't appear in any catch-all default.
        case "VERSION":
        case "XML":
        case "CLIENTPIDMAP":
        case "X-ABLABEL":
          break;
      }
    }
  }

  // Attach BIRTHPLACE/DEATHPLACE to the matching anniversary, creating an
  // anniversary entry if no BDAY/DEATHDATE was present.
  if (birthPlace || deathPlace) {
    if (!card.anniversaries) card.anniversaries = {};
    if (birthPlace) {
      let birth = Object.values(card.anniversaries).find(a => a.kind === "birth");
      if (!birth) {
        card.anniversaries.a0 = { kind: "birth", date: "" };
        birth = card.anniversaries.a0;
      }
      birth.place = { fullAddress: birthPlace };
    }
    if (deathPlace) {
      let death = Object.values(card.anniversaries).find(a => a.kind === "death");
      if (!death) {
        const key = `a${Object.keys(card.anniversaries).length}`;
        card.anniversaries[key] = { kind: "death", date: "" };
        death = card.anniversaries[key];
      }
      death.place = { fullAddress: deathPlace };
    }
  }

  const hasName = card.name && (card.name.components?.length ?? 0) > 0 || !!card.name?.full;
  const hasEmail = card.emails && Object.keys(card.emails).length > 0;
  // An organization name identifies the card just as well as a personal name.
  const hasOrg = !!Object.values(card.organizations || {})[0]?.name;
  if (!hasName && !hasEmail && !hasOrg && card.kind !== "group") return null;

  return card;
}

export function generateVCard(contacts: ContactCard[]): string {
  return contacts.map(generateSingleVCard).join("\r\n");
}

function generateSingleVCard(contact: ContactCard): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  if (contact.uid) {
    lines.push(`UID:${contact.uid}`);
  }

  if (contact.prodId) {
    lines.push(`PRODID:${contact.prodId}`);
  }

  if (contact.kind) {
    lines.push(`KIND:${contact.kind}`);
  }

  if (contact.updated) {
    lines.push(`REV:${contact.updated}`);
  }

  const components = contact.name?.components || [];
  const findKind = (...kinds: string[]) =>
    components.find(c => kinds.includes(c.kind))?.value || "";
  const given = findKind("given");
  const surname = findKind("surname");
  // Accept JSContact-standard kinds (RFC 9553) and legacy vCard-style aliases.
  const prefix = findKind("title", "prefix");
  const suffix = findKind("generation", "suffix");
  const additional = findKind("given2", "additional", "middle");

  // FN is mandatory in vCard, so fall back to the organization name for org cards.
  const fn = [prefix, given, additional, surname, suffix].filter(Boolean).join(" ")
    || contact.name?.full
    || Object.values(contact.organizations || {})[0]?.name
    || "";
  if (fn) {
    lines.push(`FN:${encodeValue(fn)}`);
    lines.push(`N:${encodeValue(surname)};${encodeValue(given)};${encodeValue(additional)};${encodeValue(prefix)};${encodeValue(suffix)}`);
  }

  if (contact.nicknames) {
    for (const nick of Object.values(contact.nicknames)) {
      lines.push(`NICKNAME:${encodeValue(nick.name)}`);
    }
  }

  if (contact.emails) {
    for (const email of Object.values(contact.emails)) {
      const type = contextToType(email.contexts);
      const params: string[] = [];
      if (type) params.push(`TYPE=${type}`);
      if (email.pref) params.push(`PREF=${email.pref}`);
      const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
      lines.push(`EMAIL${paramStr}:${email.address}`);
    }
  }

  if (contact.phones) {
    for (const phone of Object.values(contact.phones)) {
      const typeParts: string[] = [];
      const ctxType = contextToType(phone.contexts);
      if (ctxType) typeParts.push(ctxType);
      if (phone.features) {
        for (const feat of Object.keys(phone.features)) {
          if (phone.features[feat]) typeParts.push(feat.toUpperCase());
        }
      }
      const params: string[] = [];
      if (typeParts.length > 0) params.push(`TYPE=${typeParts.join(",")}`);
      if (phone.pref) params.push(`PREF=${phone.pref}`);
      const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
      lines.push(`TEL${paramStr}:${phone.number}`);
    }
  }

  if (contact.organizations) {
    for (const org of Object.values(contact.organizations)) {
      const parts = [org.name || ""];
      if (org.units) parts.push(...org.units.map(u => u.name));
      lines.push(`ORG:${parts.map(encodeValue).join(";")}`);
    }
  }

  if (contact.titles) {
    for (const title of Object.values(contact.titles)) {
      if (title.kind === "role") {
        lines.push(`ROLE:${encodeValue(title.name)}`);
      } else {
        lines.push(`TITLE:${encodeValue(title.name)}`);
      }
    }
  }

  if (contact.addresses) {
    for (const addr of Object.values(contact.addresses)) {
      const type = contextToType(addr.contexts);
      const adrParams: string[] = [];
      if (type) adrParams.push(`TYPE=${type}`);
      if (addr.countryCode) adrParams.push(`CC=${addr.countryCode}`);
      if (addr.pref) adrParams.push(`PREF=${addr.pref}`);
      const paramStr = adrParams.length > 0 ? `;${adrParams.join(";")}` : "";
      let street = addr.street || "";
      let locality = addr.locality || "";
      let region = addr.region || "";
      let postcode = addr.postcode || "";
      let country = addr.country || "";
      // RFC 9553 components-based address: extract flat fields for vCard ADR
      if (addr.components && addr.components.length > 0) {
        const findComp = (kind: string) => addr.components!.filter(c => c.kind === kind).map(c => c.value).join(' ');
        const number = findComp('number');
        const name = findComp('name');
        street = street || [number, name].filter(Boolean).join(' ');
        locality = locality || findComp('locality');
        region = region || findComp('region');
        postcode = postcode || findComp('postcode');
        country = country || findComp('country');
      }
      const parts = [
        "",
        "",
        street,
        locality,
        region,
        postcode,
        country,
      ];
      lines.push(`ADR${paramStr}:${parts.map(encodeValue).join(";")}`);
    }
  }

  if (contact.anniversaries) {
    for (const ann of Object.values(contact.anniversaries)) {
      const dateStr = anniversaryDateToVcardString(ann.date);
      if (ann.kind === "birth") {
        if (dateStr) lines.push(`BDAY:${dateStr}`);
        if (ann.place?.fullAddress) {
          lines.push(`BIRTHPLACE:${encodeValue(ann.place.fullAddress)}`);
        }
      } else if (ann.kind === "wedding") {
        if (dateStr) lines.push(`ANNIVERSARY:${dateStr}`);
      } else if (ann.kind === "death") {
        if (dateStr) lines.push(`DEATHDATE:${dateStr}`);
        if (ann.place?.fullAddress) {
          lines.push(`DEATHPLACE:${encodeValue(ann.place.fullAddress)}`);
        }
      }
    }
  }

  if (contact.onlineServices) {
    for (const svc of Object.values(contact.onlineServices)) {
      if (svc.service || svc.user) {
        // Output as IMPP for instant messaging / social profiles
        const params: string[] = [];
        if (svc.service) params.push(`X-SERVICE-TYPE=${svc.service}`);
        const ctxType = contextToType(svc.contexts);
        if (ctxType) params.push(`TYPE=${ctxType}`);
        if (svc.pref) params.push(`PREF=${svc.pref}`);
        const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
        lines.push(`IMPP${paramStr}:${svc.uri}`);
      } else {
        // Output as URL for plain web links
        const type = contextToType(svc.contexts);
        const params: string[] = [];
        if (type) params.push(`TYPE=${type}`);
        if (svc.pref) params.push(`PREF=${svc.pref}`);
        const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
        lines.push(`URL${paramStr}:${svc.uri}`);
      }
    }
  }

  if (contact.keywords) {
    const cats = Object.keys(contact.keywords).filter(k => contact.keywords![k]);
    if (cats.length > 0) {
      lines.push(`CATEGORIES:${cats.map(encodeValue).join(",")}`);
    }
  }

  if (contact.preferredLanguages) {
    for (const lang of Object.values(contact.preferredLanguages)) {
      const type = contextToType(lang.contexts);
      const params: string[] = [];
      if (type) params.push(`TYPE=${type}`);
      if (lang.pref) params.push(`PREF=${lang.pref}`);
      const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
      lines.push(`LANG${paramStr}:${lang.language}`);
    }
  }

  if (contact.relatedTo) {
    for (const [uri, rel] of Object.entries(contact.relatedTo)) {
      const relType = rel.relation ? Object.keys(rel.relation).find(k => rel.relation![k]) : undefined;
      const typeParam = relType ? `;TYPE=${relType}` : "";
      lines.push(`RELATED${typeParam}:${uri}`);
    }
  }

  if (contact.cryptoKeys) {
    for (const key of Object.values(contact.cryptoKeys)) {
      const type = contextToType(key.contexts);
      const params: string[] = [];
      if (type) params.push(`TYPE=${type}`);
      if (key.mediaType) params.push(`MEDIATYPE=${key.mediaType}`);
      const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
      lines.push(`KEY${paramStr}:${key.uri}`);
    }
  }

  if (contact.personalInfo) {
    // RFC 6715 - emit EXPERTISE / HOBBY / INTEREST with LEVEL.
    const levelOut: Record<string, Record<string, string>> = {
      expertise: { high: "expert", medium: "average", low: "beginner" },
      hobby: { high: "high", medium: "medium", low: "low" },
      interest: { high: "high", medium: "medium", low: "low" },
    };
    for (const info of Object.values(contact.personalInfo)) {
      const propMap: Record<string, string> = {
        expertise: "EXPERTISE", hobby: "HOBBY", interest: "INTEREST",
      };
      const prop = propMap[info.kind];
      if (!prop) continue;
      const levelParam = info.level && levelOut[info.kind]?.[info.level]
        ? `;LEVEL=${levelOut[info.kind][info.level]}` : "";
      lines.push(`${prop}${levelParam}:${encodeValue(info.value)}`);
    }
  }

  if (contact.directories) {
    for (const dir of Object.values(contact.directories)) {
      const mt = dir.mediaType ? `;MEDIATYPE=${dir.mediaType}` : "";
      lines.push(`ORG-DIRECTORY${mt}:${dir.uri}`);
    }
  }

  if (contact.links) {
    // RFC 8605 CONTACT-URI for kind=contact; everything else falls back to URL.
    for (const link of Object.values(contact.links)) {
      const params: string[] = [];
      const type = contextToType(link.contexts);
      if (type) params.push(`TYPE=${type}`);
      if (link.pref) params.push(`PREF=${link.pref}`);
      const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
      const prop = link.kind === "contact" ? "CONTACT-URI" : "URL";
      lines.push(`${prop}${paramStr}:${link.uri}`);
    }
  }

  if (contact.notes) {
    for (const n of Object.values(contact.notes)) {
      lines.push(`NOTE:${encodeValue(n.note)}`);
    }
  }

  if (contact.members) {
    for (const memberId of Object.keys(contact.members)) {
      if (contact.members[memberId]) {
        lines.push(`MEMBER:urn:uuid:${memberId}`);
      }
    }
  }

  if (contact.media) {
    for (const media of Object.values(contact.media)) {
      if (media.uri) {
        const prop = media.kind === "logo" ? "LOGO" : media.kind === "sound" ? "SOUND" : "PHOTO";
        if (media.uri.startsWith("data:")) {
          const match = media.uri.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            lines.push(`${prop};ENCODING=b;TYPE=${match[1]}:${match[2]}`);
          }
        } else {
          const mt = media.mediaType ? `;MEDIATYPE=${media.mediaType}` : "";
          lines.push(`${prop};VALUE=URI${mt}:${media.uri}`);
        }
      }
    }
  }

  // GEO and TZ from addresses
  if (contact.addresses) {
    for (const addr of Object.values(contact.addresses)) {
      if (addr.coordinates) {
        lines.push(`GEO:${addr.coordinates}`);
      }
      if (addr.timeZone) {
        lines.push(`TZ:${addr.timeZone}`);
      }
    }
  }

  if (contact.speakToAs) {
    const sex = contact.speakToAs.grammaticalGender
      ? grammaticalGenderToVcardSex(contact.speakToAs.grammaticalGender)
      : "";
    const pronouns = contact.speakToAs.pronouns;
    const identity = pronouns ? Object.values(pronouns)[0]?.pronouns || "" : "";
    if (sex || identity) {
      lines.push(`GENDER:${sex}${identity ? `;${identity}` : ""}`);
    }
  }

  if (contact.calendarUri) {
    lines.push(`CALURI:${contact.calendarUri}`);
  }

  if (contact.schedulingUri) {
    lines.push(`CALADRURI:${contact.schedulingUri}`);
  }

  if (contact.freeBusyUri) {
    lines.push(`FBURL:${contact.freeBusyUri}`);
  }

  if (contact.source) {
    lines.push(`SOURCE:${contact.source}`);
  }

  if (contact.created) {
    // RFC 9554 §3.1 - CREATED is a timestamp; emit as-is for round-trip.
    lines.push(`CREATED:${contact.created}`);
  }

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export function detectDuplicates(
  existing: ContactCard[],
  incoming: ContactCard[]
): Map<number, string> {
  const dupes = new Map<number, string>();
  const existingEmails = new Map<string, string>();

  for (const c of existing) {
    if (c.emails) {
      for (const e of Object.values(c.emails)) {
        existingEmails.set(e.address.toLowerCase(), c.id);
      }
    }
  }

  incoming.forEach((card, idx) => {
    if (card.emails) {
      for (const e of Object.values(card.emails)) {
        const match = existingEmails.get(e.address.toLowerCase());
        if (match) {
          dupes.set(idx, match);
          return;
        }
      }
    }
  });

  return dupes;
}
