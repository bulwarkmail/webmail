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
  return vcf.replace(/\r\n[ \t]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  const parts = paramStr.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      params[part.substring(0, eq).toUpperCase()] = part.substring(eq + 1).replace(/"/g, "");
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
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx < 1) continue;
      const keyPart = trimmed.substring(0, colonIdx);
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

  for (const [fullKey, values] of Object.entries(raw)) {
    const semiIdx = fullKey.indexOf(";");
    const propName = (semiIdx > 0 ? fullKey.substring(0, semiIdx) : fullKey).toUpperCase();
    const paramStr = semiIdx > 0 ? fullKey.substring(semiIdx + 1) : "";
    const params = parseParams(paramStr);

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
            address: val,
            contexts: typeToContext(params.TYPE),
          };
          break;
        }

        case "TEL": {
          if (!card.phones) card.phones = {};
          const idx = Object.keys(card.phones).length;
          card.phones[`p${idx}`] = {
            number: val,
            contexts: typeToContext(params.TYPE),
            features: typeToPhoneFeatures(params.TYPE),
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
            contexts: typeToContext(params.TYPE),
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
          const k = val.toLowerCase();
          if (k === "group" || k === "individual" || k === "org") {
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
          const mediaType = params.TYPE || params.MEDIATYPE || "";
          if (encoding === "B" || encoding === "BASE64") {
            // Inline base64 photo - construct a data URI
            const mime = mediaType.includes("/") ? mediaType : mediaType ? `image/${mediaType.toLowerCase()}` : "image/jpeg";
            card.media[`m${idx}`] = {
              kind: "photo",
              uri: `data:${mime};base64,${rawValue}`,
              mediaType: mime,
            };
          } else if (val.startsWith("data:") || val.startsWith("http://") || val.startsWith("https://")) {
            // URI value (data URI or URL)
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
            label: params.TYPE?.toLowerCase() === "home" || params.TYPE?.toLowerCase() === "work" ? undefined : params.TYPE,
          };
          break;
        }

        case "IMPP":
        case "X-SOCIALPROFILE": {
          if (!card.onlineServices) card.onlineServices = {};
          const idx = Object.keys(card.onlineServices).length;
          const svc: ContactOnlineService = {
            uri: val,
            contexts: typeToContext(params.TYPE),
          };
          if (params["X-SERVICE-TYPE"]) {
            svc.service = params["X-SERVICE-TYPE"];
          } else if (propName === "X-SOCIALPROFILE" && params.TYPE) {
            const typeVal = params.TYPE.toLowerCase();
            if (typeVal !== "work" && typeVal !== "home") {
              svc.service = params.TYPE;
            }
          }
          if (params["X-USER"]) svc.user = params["X-USER"];
          card.onlineServices[`u${idx}`] = svc;
          break;
        }

        case "BDAY": {
          if (!card.anniversaries) card.anniversaries = {};
          card.anniversaries.a0 = { kind: "birth", date: val };
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
            contexts: typeToContext(params.TYPE),
          };
          break;
        }

        case "RELATED": {
          if (!card.relatedTo) card.relatedTo = {};
          const relType = params.TYPE?.toLowerCase();
          const relation: Record<string, boolean> = {};
          if (relType) relation[relType] = true;
          card.relatedTo[val] = { relation: Object.keys(relation).length > 0 ? relation : undefined };
          break;
        }

        case "LANG": {
          if (!card.preferredLanguages) card.preferredLanguages = {};
          const idx = Object.keys(card.preferredLanguages).length;
          card.preferredLanguages[`l${idx}`] = {
            language: val,
            contexts: typeToContext(params.TYPE),
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
          const gParts = val.split(";");
          const sexCode = gParts[0]?.toUpperCase();
          const identityText = gParts[1];
          if (sexCode || identityText) {
            card.speakToAs = {};
            if (sexCode) {
              card.speakToAs.grammaticalGender = vcardSexToGrammaticalGender(sexCode);
            }
            if (identityText) {
              card.speakToAs.pronouns = { p0: { pronouns: identityText } };
            }
          }
          break;
        }

        case "LOGO": {
          if (!card.media) card.media = {};
          const idx = Object.keys(card.media).length;
          const encoding = params.ENCODING?.toUpperCase();
          const mediaType = params.TYPE || params.MEDIATYPE || "";
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
          const mediaType = params.TYPE || params.MEDIATYPE || "";
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
      }
    }
  }

  const hasName = card.name && (card.name.components?.length ?? 0) > 0 || !!card.name?.full;
  const hasEmail = card.emails && Object.keys(card.emails).length > 0;
  if (!hasName && !hasEmail && card.kind !== "group") return null;

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

  const fn = [prefix, given, additional, surname, suffix].filter(Boolean).join(" ") || contact.name?.full || "";
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
      const typeParam = type ? `;TYPE=${type}` : "";
      lines.push(`EMAIL${typeParam}:${email.address}`);
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
      const typeParam = typeParts.length > 0 ? `;TYPE=${typeParts.join(",")}` : "";
      lines.push(`TEL${typeParam}:${phone.number}`);
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
      const typeParam = type ? `;TYPE=${type}` : "";
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
      lines.push(`ADR${typeParam}:${parts.map(encodeValue).join(";")}`);
    }
  }

  if (contact.anniversaries) {
    for (const ann of Object.values(contact.anniversaries)) {
      const dateStr = anniversaryDateToVcardString(ann.date);
      if (ann.kind === "birth") {
        lines.push(`BDAY:${dateStr}`);
      } else if (ann.kind === "wedding") {
        lines.push(`ANNIVERSARY:${dateStr}`);
      } else if (ann.kind === "death") {
        lines.push(`DEATHDATE:${dateStr}`);
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
        const paramStr = params.length > 0 ? `;${params.join(";")}` : "";
        lines.push(`IMPP${paramStr}:${svc.uri}`);
      } else {
        // Output as URL for plain web links
        const type = contextToType(svc.contexts);
        const typeParam = type ? `;TYPE=${type}` : "";
        lines.push(`URL${typeParam}:${svc.uri}`);
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
      const typeParam = type ? `;TYPE=${type}` : "";
      lines.push(`LANG${typeParam}:${lang.language}`);
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
      const typeParam = type ? `;TYPE=${type}` : "";
      lines.push(`KEY${typeParam}:${key.uri}`);
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
