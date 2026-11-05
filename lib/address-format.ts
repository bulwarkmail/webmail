import type { AddressComponent, ContactAddress } from "@/lib/jmap/types";

/**
 * Postal addresses laid out the way the address's country writes them.
 *
 * Two things differ between countries here: whether the house number comes
 * after the street name ("Hauptstraße 1") or before it ("1 Main Street"), and
 * whether the postcode leads the town line ("10115 Berlin", "75001 Paris"),
 * follows it ("Springfield, IL 62701") or has a line of its own (UK).
 */

export type StreetOrder = "number-after" | "number-before";
export type TownLine = "postcode-city" | "city-region-postcode" | "city-then-postcode";

export interface AddressStyle {
  street: StreetOrder;
  town: TownLine;
}

const NUMBER_AFTER = [
  "DE", "AT", "CH", "LI", "NL", "BE", "IT", "SM", "VA", "ES", "AD", "PT", "DK", "IS", "NO", "SE", "FI",
  "PL", "CZ", "SK", "HU", "SI", "HR", "BA", "RS", "ME", "MK", "AL", "RO", "BG", "GR", "CY", "TR",
  "EE", "LV", "LT", "RU", "UA", "BY", "MX", "AR", "BR", "CL", "UY", "PY", "BO", "PE", "VE", "EC",
];
const NUMBER_BEFORE = ["US", "CA", "GB", "IE", "FR", "MC", "LU", "AU", "NZ", "ZA", "IN", "SG", "PH", "MY", "IL", "HK"];
const CITY_REGION_POSTCODE = ["US", "CA", "AU"];
const CITY_THEN_POSTCODE = ["GB", "IE"];

const KNOWN_CODES = [...NUMBER_AFTER, ...NUMBER_BEFORE];

/** The style for an ISO 3166 code, or null for a country this file doesn't know. */
export function styleForCountryCode(code: string | undefined | null): AddressStyle | null {
  const cc = code?.trim().toUpperCase();
  if (!cc) return null;
  const c = cc === "UK" ? "GB" : cc;
  if (!KNOWN_CODES.includes(c)) return null;
  return {
    street: NUMBER_AFTER.includes(c) ? "number-after" : "number-before",
    town: CITY_REGION_POSTCODE.includes(c) ? "city-region-postcode"
      : CITY_THEN_POSTCODE.includes(c) ? "city-then-postcode"
        : "postcode-city",
  };
}

// Country names as people type them: each known code's name in these
// languages, plus a few short forms.
const NAME_LOCALES = ["en", "de", "fr", "es", "it", "nl", "pt", "pl", "sv", "da", "nb", "fi", "cs", "sk", "hu", "tr", "ru", "uk", "ro", "el", "hr", "sl", "et", "lv", "lt", "ca"];
const ALIASES: Record<string, string> = {
  usa: "US", "u.s.a.": "US", "u.s.": "US", "united states of america": "US", america: "US",
  uk: "GB", "u.k.": "GB", england: "GB", scotland: "GB", wales: "GB", "great britain": "GB", "northern ireland": "GB",
  holland: "NL", brd: "DE", "bundesrepublik deutschland": "DE", "the netherlands": "NL",
  "schweiz": "CH", "suisse": "CH", "svizzera": "CH", "österreich": "AT", "osterreich": "AT",
};
let nameIndex: Map<string, string> | null = null;

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function countryNameIndex(): Map<string, string> {
  if (nameIndex) return nameIndex;
  const index = new Map<string, string>();
  for (const [alias, code] of Object.entries(ALIASES)) index.set(alias, code);
  for (const locale of NAME_LOCALES) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      continue;
    }
    for (const code of KNOWN_CODES) {
      const name = names.of(code);
      if (name && name !== code) {
        const key = normalise(name);
        if (!index.has(key)) index.set(key, code);
      }
    }
  }
  nameIndex = index;
  return index;
}

/** The ISO code for a typed country ("Germany", "Deutschland", "DE"), or null. */
export function countryCodeFromName(country: string | undefined | null): string | null {
  const key = normalise(country ?? "");
  if (!key) return null;
  if (/^[a-z]{2}$/.test(key)) {
    const code = key.toUpperCase() === "UK" ? "GB" : key.toUpperCase();
    return KNOWN_CODES.includes(code) ? code : null;
  }
  return countryNameIndex().get(key) ?? null;
}

// The country a UI language most likely means, for addresses without one.
const LANGUAGE_COUNTRY: Record<string, string> = {
  de: "DE", nl: "NL", it: "IT", es: "ES", ca: "ES", pt: "PT", da: "DK", nb: "NO", nn: "NO", sv: "SE", fi: "FI",
  pl: "PL", cs: "CZ", sk: "SK", hu: "HU", ro: "RO", tr: "TR", et: "EE", lv: "LV", lt: "LT", ru: "RU",
  uk: "UA", el: "GR", fr: "FR", en: "US",
};

/**
 * The style for an address: from its country code, else its country's name,
 * else the UI language's country, else US style.
 */
export function addressStyle(country: string | undefined | null, countryCode?: string | null, locale?: string): AddressStyle {
  return styleForCountryCode(countryCode)
    ?? styleForCountryCode(countryCodeFromName(country))
    ?? styleForCountryCode(LANGUAGE_COUNTRY[(locale ?? "").split(/[-_]/)[0].toLowerCase()])
    ?? { street: "number-before", town: "city-region-postcode" };
}

/** "Hauptstraße" + "1" as the country writes it. */
export function joinStreet(name: string, number: string, order: StreetOrder): string {
  const parts = order === "number-after" ? [name, number] : [number, name];
  return parts.map(p => p.trim()).filter(Boolean).join(" ");
}

const HOUSE_NUMBER = String.raw`\d+\s?[a-zA-Z]?(?:\s?[-–/]\s?\d+\s?[a-zA-Z]?)?`;
const NUMBER_LAST = new RegExp(String.raw`^(.*\S)\s+(${HOUSE_NUMBER})$`);
const NUMBER_FIRST = new RegExp(String.raw`^(${HOUSE_NUMBER})\s+(\S.*)$`);

/**
 * Splits a typed street line into street name and house number where the
 * number sits where the country puts it. Anything else stays whole as the
 * name ("Am Markt", "Hauptstraße 1, Hinterhaus").
 */
export function splitStreet(line: string, order: StreetOrder): { name: string; number: string } {
  const text = line.trim().replace(/\s+/g, " ");
  if (order === "number-after") {
    const m = NUMBER_LAST.exec(text);
    if (m) return { name: m[1].replace(/,$/, ""), number: m[2] };
  } else {
    const m = NUMBER_FIRST.exec(text);
    if (m) return { name: m[2], number: m[1].replace(/,$/, "") };
  }
  return { name: text, number: "" };
}

/** Kinds the contact form shows as fields of their own. */
const FORM_KINDS = new Set(["name", "number", "locality", "region", "postcode", "country", "separator"]);
/** Kinds that belong on the street line ("Hauptstraße 1, 3. OG"). */
const STREET_EXTRAS = new Set(["apartment", "room", "floor", "building", "block", "direction", "landmark"]);

function valuesOf(components: AddressComponent[], kind: string): string {
  return components.filter(c => c.kind === kind).map(c => c.value?.trim()).filter(Boolean).join(" ");
}

/** The parts of an address as the contact form edits them. */
export interface AddressParts {
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
}

/**
 * The form's fields for an address. Street name and number become one line in
 * the order of the address's country; for a country not known here, in the
 * order the components have.
 */
export function addressToParts(address: ContactAddress, locale?: string): AddressParts {
  const components = address.components ?? [];
  if (components.length === 0) {
    return {
      street: address.street ?? "",
      locality: address.locality ?? "",
      region: address.region ?? "",
      postcode: address.postcode ?? "",
      country: address.country ?? "",
    };
  }
  const country = valuesOf(components, "country");
  const name = valuesOf(components, "name");
  const number = valuesOf(components, "number");
  const known = styleForCountryCode(address.countryCode) ?? styleForCountryCode(countryCodeFromName(country));
  let order: StreetOrder;
  if (known) order = known.street;
  else {
    const nameAt = components.findIndex(c => c.kind === "name");
    const numberAt = components.findIndex(c => c.kind === "number");
    order = nameAt >= 0 && numberAt >= 0
      ? (numberAt > nameAt ? "number-after" : "number-before")
      : addressStyle(country, null, locale).street;
  }
  return {
    street: joinStreet(name, number, order),
    locality: valuesOf(components, "locality"),
    region: valuesOf(components, "region"),
    postcode: valuesOf(components, "postcode"),
    country,
  };
}

const sep = (value: string): AddressComponent => ({ kind: "separator", value });

/**
 * RFC 9553 components for edited form fields, in the country's order, with
 * separators inside a line and `defaultSeparator` (", ") between lines.
 * Components the form doesn't show (apartment, district, PO box...) are kept
 * from `previous`.
 */
export function partsToComponents(parts: AddressParts, previous: AddressComponent[] = [], locale?: string, countryCode?: string | null): AddressComponent[] {
  const style = addressStyle(parts.country, countryCode, locale);
  const { name, number } = splitStreet(parts.street, style.street);
  const extras = previous.filter(c => !FORM_KINDS.has(c.kind) && c.value?.trim());
  const comp = (kind: string, value: string): AddressComponent[] => value.trim() ? [{ kind, value: value.trim() }] : [];
  const line = (...groups: AddressComponent[][]): AddressComponent[] => {
    const filled = groups.filter(g => g.length > 0);
    return filled.flatMap((g, i) => (i === 0 ? g : [sep(" "), ...g]));
  };

  const streetLine = style.street === "number-after"
    ? line(comp("name", name), comp("number", number))
    : line(comp("number", number), comp("name", name));
  const streetExtras = extras.filter(c => STREET_EXTRAS.has(c.kind));
  const otherExtras = extras.filter(c => !STREET_EXTRAS.has(c.kind));

  const lines: AddressComponent[][] = [streetLine, ...streetExtras.map(c => [c]), ...otherExtras.map(c => [c])];
  if (style.town === "postcode-city") {
    lines.push(line(comp("postcode", parts.postcode), comp("locality", parts.locality)), comp("region", parts.region));
  } else if (style.town === "city-region-postcode") {
    lines.push(comp("locality", parts.locality), line(comp("region", parts.region), comp("postcode", parts.postcode)));
  } else {
    lines.push(comp("locality", parts.locality), comp("region", parts.region), comp("postcode", parts.postcode));
  }
  lines.push(comp("country", parts.country));
  // Lines follow each other through defaultSeparator, so no separator between them.
  return lines.filter(l => l.length > 0).flat();
}

/**
 * An address as lines to show, laid out for its country: "Hauptstraße 1" /
 * "10000 Berlin" / "Germany". Addresses without components show their `full`
 * text or their flat fields.
 */
export function formatAddressLines(address: ContactAddress, locale?: string): string[] {
  const components = (address.components ?? []).filter(c => c.kind !== "separator" && c.value?.trim());
  if (components.length === 0) {
    const full = address.full || address.fullAddress;
    if (full) return full.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  const parts = addressToParts(address, locale);
  const style = addressStyle(parts.country, address.countryCode, locale);
  const lines: string[] = [];
  const extras = components.filter(c => !FORM_KINDS.has(c.kind));
  const streetExtras = extras.filter(c => STREET_EXTRAS.has(c.kind)).map(c => c.value.trim());
  const street = [parts.street, ...streetExtras].filter(Boolean).join(", ");
  if (street) lines.push(street);
  for (const c of extras.filter(c => !STREET_EXTRAS.has(c.kind))) lines.push(c.value.trim());
  const join = (...xs: string[]) => xs.map(x => x.trim()).filter(Boolean).join(" ");
  if (style.town === "postcode-city") {
    lines.push(join(parts.postcode, parts.locality), parts.region);
  } else if (style.town === "city-region-postcode") {
    const regionPostcode = join(parts.region, parts.postcode);
    lines.push([parts.locality.trim(), regionPostcode].filter(Boolean).join(", "));
  } else {
    lines.push(parts.locality, parts.region, parts.postcode);
  }
  lines.push(parts.country);
  return lines.map(l => l.trim()).filter(Boolean);
}
