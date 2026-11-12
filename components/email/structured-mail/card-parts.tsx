"use client";

import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink } from "@/components/icons";
import { toAsciiDomain } from "@/lib/idn";
import { openExternalLink } from "@/lib/plugin-hook-result";
import { getRootDomain } from "@/lib/root-domain";
import { formatMoment, formatMomentTime, isOtherZone, isWebLink, type FormatOptions } from "@/lib/structured-mail/format";
import { isTransport, type Item, type Link, type Moment, type Place, type ReservationStatus, type Shipment, type StructuredCard } from "@/lib/structured-mail/types";
import { resolveTimeZone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export const ACTION_CLASS =
  "inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]";
export const PILL_CLASS = "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap";
/** The copy chip in an action row, as tall as the buttons beside it. */
export const ACTION_CHIP_CLASS = "min-h-[36px] px-3 text-sm";

/** Locale, clock and the reader's zone, for formatting a card's times. */
export function useCardFormat(): { opts: FormatOptions; readerZone: string } {
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeZone = useSettingsStore((s) => s.timeZone);
  return {
    opts: { locale, hour12: timeFormat === "12h" ? true : timeFormat === "24h" ? false : undefined },
    readerZone: resolveTimeZone(timeZone),
  };
}

/**
 * A time as the mail gave it, at the place. `timeOnly` leaves out the date
 * (an arrival on the departure day). Marked "local time" when the place's
 * clock differs from the reader's at that instant.
 */
export function When({ at, timeOnly = false, struck = false }: { at: Moment; timeOnly?: boolean; struck?: boolean }) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts, readerZone } = useCardFormat();
  const text = timeOnly && at.time ? formatMomentTime(at, opts) : formatMoment(at, opts);
  const other = isOtherZone(at, readerZone);
  return (
    <>
      <span className={cn("text-foreground/90 whitespace-nowrap", struck && "line-through")}>{text}</span>
      {other && (
        <span className="ms-1 text-xs text-muted-foreground" title={t("local_time_title")} data-testid="local-time-hint">
          {t("local_time")}
        </span>
      )}
    </>
  );
}

/** One meta row: a small icon and text that wraps instead of overflowing. */
export function MetaRow({ icon: Icon, children, className }: { icon: IconType; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-1.5 min-w-0", className)}>
      <Icon aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0 mt-[0.1875rem]" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

const STATUS_TONE: Record<Exclude<ReservationStatus, "confirmed">, string> = {
  cancelled: "bg-destructive/15 text-destructive",
  pending: "bg-warning/15 text-warning",
  hold: "bg-warning/15 text-warning",
};

/** Cancelled, Pending or On hold; nothing for a confirmed booking. */
export function BookingStatusPill({ status }: { status?: ReservationStatus }) {
  const t = useTranslations("email_viewer.structured_mail");
  if (!status || status === "confirmed") return null;
  const label = status === "cancelled" ? t("status_cancelled") : status === "pending" ? t("status_pending") : t("status_hold");
  return <span className={cn(PILL_CLASS, STATUS_TONE[status])}>{label}</span>;
}

/** A host name in ASCII form, lower case, without a trailing dot. */
function asciiHost(host: string): string {
  return (toAsciiDomain(host) ?? host).toLowerCase().replace(/\.$/, "");
}

/**
 * The domain of a card's sender, in ASCII form: the From domain the receiving
 * server verified (a card shows only for such a message, see
 * lib/structured-mail/trust.ts). Empty without a From address.
 */
export function cardSenderDomain(from: { email?: string | null }[] | null | undefined): string {
  const address = from?.[0]?.email ?? "";
  const at = address.lastIndexOf("@");
  return at >= 0 ? asciiHost(address.slice(at + 1).trim()) : "";
}

/**
 * Whether `host` lies outside the sender's domain: neither the From domain
 * nor below it, and not under the same registrable domain either
 * (lib/root-domain.ts; a list of common suffixes, so that is the wider match
 * only). Without a sender domain every host is outside.
 */
export function isOutsideSender(host: string, senderDomain: string): boolean {
  if (!senderDomain) return true;
  const target = asciiHost(host);
  if (!target) return true;
  if (target === senderDomain || target.endsWith(`.${senderDomain}`)) return false;
  return getRootDomain(target) !== getRootDomain(senderDomain);
}

/*
 * What a card may show of the sender's text. A card is drawn for a message
 * that passed the sender check for its From domain, so no text on it may read
 * as another domain. namesOtherDomain decides for every text of every card
 * (cardForDisplay), in three steps on the text after NFKC:
 *
 * 1. Only expected characters: letters, marks and numbers of any script, the
 *    space, currency signs and CARD_PUNCTUATION. A text with any other code
 *    point is left out whole.
 * 2. A dot is whatever stands where a dot would stand: a character between
 *    two labels that is no word joiner (WORD_JOINERS), a letter that
 *    letterDots finds, or a space or joiner with combining marks on it
 *    (SPACE_WITH_MARKS); two or more in a row are one dot. Spaces other than
 *    U+0020 count as nothing.
 * 3. A run of labels names a domain when its last label is a top-level domain
 *    (lib/top-level-domains.ts), or, whatever it ends in, when it reads as a
 *    look-alike (runNamesOtherDomain). A text is also read with the Greek and
 *    Cyrillic letters that draw like Latin ones as those Latin letters
 *    (namesOtherDomain).
 */

type CodeRange = number | readonly [number, number];
const codePoint = (code: number) => `\\u{${code.toString(16)}}`;
const charClass = (ranges: readonly CodeRange[]) =>
  ranges.map((r) => (typeof r === "number" ? codePoint(r) : `${codePoint(r[0])}-${codePoint(r[1])}`)).join("");

/**
 * The punctuation and symbols a card text may hold besides letters, marks,
 * numbers, currency signs and the space, as they are after NFKC. NFKC already
 * turns the fullwidth forms into ASCII, the ellipsis into three dots, №, ™
 * and ℃ into letters, ½ into 1⁄2, and the no-break and other width spaces
 * into U+0020, so none of those needs an entry.
 */
const CARD_PUNCTUATION: readonly CodeRange[] = [
  // ASCII punctuation and symbols
  [0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e],
  // Latin-1: ¡ ¢ £ ¤ ¥ ¦ § © « ¬ ® ° ± ¶ · » ¿ × ÷
  [0xa1, 0xa7], 0xa9, 0xab, 0xac, 0xae, 0xb0, 0xb1, 0xb6, 0xb7, 0xbb, 0xbf, 0xd7, 0xf7,
  // Hyphen, figure dash, en dash, em dash, horizontal bar
  [0x2010, 0x2015],
  // Quotes ‘ ’ ‚ ‛ “ ” „ ‟, daggers † ‡, bullet •, hyphenation point ‧
  [0x2018, 0x2022], 0x2027,
  // Per mille ‰, prime ′, single guillemets ‹ ›, fraction slash ⁄
  0x2030, 0x2032, 0x2039, 0x203a, 0x2044,
  // Arrows
  [0x2190, 0x21ff],
  // Minus −, ≈ ≠ ≤ ≥
  0x2212, 0x2248, 0x2260, 0x2264, 0x2265,
  // The stars of a hotel rating ★ ☆
  0x2605, 0x2606,
  // CJK comma, full stop and ditto mark, brackets, wave dash, katakana middle dot
  [0x3001, 0x3003], [0x3008, 0x3011], [0x3014, 0x301f], 0x30fb,
  // Arabic comma, semicolon, question mark, percent sign, decimal and thousands separator, full stop
  0x060c, 0x061b, 0x061f, [0x066a, 0x066c], 0x06d4,
  // Hebrew maqaf, geresh, gershayim
  0x05be, 0x05f3, 0x05f4,
  // Devanagari danda and double danda
  0x0964, 0x0965,
];

/**
 * Step 1: a card text after NFKC holds nothing else. That leaves out every
 * format character (direction controls, the zero width space and word joiner,
 * tag characters; SOFT_INVISIBLES are taken out before), control, private
 * use, unassigned and surrogate code point, line and paragraph separator, and
 * emoji.
 */
const CARD_TEXT = new RegExp(`^[\\p{L}\\p{M}\\p{N}\\p{Sc} ${charClass(CARD_PUNCTUATION)}]*$`, "u");
/** Letters and marks that draw as nothing (Hangul fillers, Khmer inherent vowels, variation selectors) are left out too. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** The hyphen-minus and HYPHEN (U+2010, which NFKC also makes of the non-breaking hyphen). */
const HYPHENS = `-${codePoint(0x2010)}`;
/** A character of a label: a letter, mark or digit of any script, or a hyphen. */
const LABEL_CHAR = new RegExp(`[${HYPHENS}\\p{L}\\p{M}\\p{N}]`, "u");
const LETTER = /\p{L}/u;
const NUMBER = /\p{N}/u;
const CASED = /\p{Cased}/u;
const ASCII_ONLY = /^\p{ASCII}*$/u;
const LEADING_MARKS = /^\p{M}+/u;
const HYPHEN = new RegExp(`[${HYPHENS}]`, "u");

/**
 * What honest text puts between two words without a space, and which does not
 * read as the dot of a domain: dashes, slash, apostrophes, ampersand, plus,
 * colon, comma, brackets, the arrow, and the underscore of references such as
 * "INV_DE_123" (no host name has one). Every other character between two
 * labels stands for a dot, the middle dot and the bullet among them.
 */
const WORD_JOINERS = new Set([..."–—/'’&+:,()→_"]);

/**
 * SOFT HYPHEN, ZERO WIDTH NON-JOINER and ZERO WIDTH JOINER draw nothing
 * between letters and carry no direction. The check reads a text without
 * them; the card keeps the two joiners, which Persian and Sinhala spelling
 * needs, and drops the soft hyphen (textForDisplay).
 */
const SOFT_INVISIBLES = new RegExp(`[${charClass([0xad, 0x200c, 0x200d])}]`, "gu");
const SOFT_HYPHEN = new RegExp(charClass([0xad]), "gu");
/**
 * Spaces other than U+0020 (no-break, the narrow, thin and hair spaces,
 * ideographic): some draw as almost nothing, so the check reads a text
 * without them. The parser turns them into a full space for the card.
 */
const OTHER_SPACES = new RegExp(`[${charClass([0xa0, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000])}]`, "gu");
/**
 * A space or word joiner with combining marks on it: the marks are drawn in
 * the gap, some as a dot just below the baseline (THAI CHARACTER PHINTHU), so
 * the check reads the whole as one dot. NFKC writes spacing diacritics (¸ ˛
 * ´) as a space and a mark, which this covers after NFKC.
 */
const SPACE_WITH_MARKS = new RegExp(
  `[\\p{Zs}${charClass([...WORD_JOINERS].map((ch) => ch.codePointAt(0) ?? 0))}]+\\p{M}+`,
  "gu",
);
const MARK = /\p{M}/u;

/**
 * Scripts with many letters that draw like Latin ones and no honest use for
 * a dotted name on a card: Cherokee, Lisu, Coptic, Deseret and Osage; and the
 * mathematical alphanumeric, enclosed and fullwidth forms. NFKC folds those
 * forms into plain letters and step 1 leaves out the symbols among them, so
 * the blocks only catch what a later Unicode version adds without a fold.
 */
const NO_HONEST_USE = new RegExp(
  `[\\p{Script=Cherokee}\\p{Script=Lisu}\\p{Script=Coptic}\\p{Script=Deseret}\\p{Script=Osage}${charClass([[0x1d400, 0x1d7ff], [0x2460, 0x24ff], [0x1f100, 0x1f1ff], [0xff00, 0xffef]])}]`,
  "u",
);

/**
 * Unicode's scripts, the ones card text uses most first. A name the browser
 * does not know is skipped, and its letters count as one unknown script.
 */
const SCRIPT_NAMES = (
  "Latin Common Inherited Cyrillic Greek Han Hiragana Katakana Hangul Bopomofo Arabic Hebrew Thai Devanagari " +
  "Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Georgian Armenian Ethiopic Lao Khmer " +
  "Myanmar Tibetan Mongolian Syriac Thaana Nko Tifinagh Cherokee Canadian_Aboriginal Lisu Vai Bamum Coptic " +
  "Glagolitic Gothic Runic Ogham Javanese Balinese Sundanese Batak Buginese Makasar Rejang Cham Tai_Le New_Tai_Lue " +
  "Tai_Tham Tai_Viet Kayah_Li Lepcha Limbu Ol_Chiki Saurashtra Sharada Siddham Tirhuta Takri Khojki Khudawadi " +
  "Mahajani Modi Multani Newa Dogra Grantha Kaithi Bhaiksuki Marchen Zanabazar_Square Soyombo Masaram_Gondi " +
  "Gunjala_Gondi Chakma Meetei_Mayek Syloti_Nagri Brahmi Kharoshthi Adlam Bassa_Vah Mende_Kikakui Medefaidrin Miao " +
  "Mro Nyiakeng_Puachue_Hmong Pahawh_Hmong Wancho Osage Osmanya Deseret Shavian Duployan SignWriting Yi Nushu " +
  "Tangut Khitan_Small_Script Hanifi_Rohingya Yezidi Elbasan Caucasian_Albanian Vithkuqi Old_Hungarian Old_Italic " +
  "Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_North_Arabian Old_Turkic Old_Uyghur Sogdian Chorasmian " +
  "Elymaic Avestan Carian Lycian Lydian Cypriot Cypro_Minoan Linear_A Linear_B Ugaritic Phoenician Samaritan " +
  "Mandaic Manichaean Nabataean Palmyrene Hatran Imperial_Aramaic Inscriptional_Pahlavi Inscriptional_Parthian " +
  "Psalter_Pahlavi Meroitic_Cursive Meroitic_Hieroglyphs Egyptian_Hieroglyphs Anatolian_Hieroglyphs Cuneiform " +
  "Sora_Sompeng Tagalog Tagbanwa Hanunoo Buhid Phags_Pa Ahom Dives_Akuru Nandinagari Warang_Citi Pau_Cin_Hau Tangsa " +
  "Toto Kawi Nag_Mundari Braille Garay Gurung_Khema Kirat_Rai Ol_Onal Sunuwar Todhri Tulu_Tigalari"
).split(" ");
/** Japanese, Chinese and Korean write these together in one word, and next to Latin. */
const EAST_ASIAN = ["Han", "Hiragana", "Katakana", "Hangul", "Bopomofo"];

let scriptTests: Map<string, { is: RegExp; uses: RegExp }> | undefined;
function knownScripts(): Map<string, { is: RegExp; uses: RegExp }> {
  if (!scriptTests) {
    scriptTests = new Map();
    for (const name of SCRIPT_NAMES) {
      try {
        scriptTests.set(name, { is: new RegExp(`\\p{Script=${name}}`, "u"), uses: new RegExp(`\\p{Script_Extensions=${name}}`, "u") });
      } catch {
        // A script this browser does not know yet.
      }
    }
  }
  return scriptTests;
}

const scriptCache = new Map<string, string>();
/** The script of a character ("Latin", "Common", ...), "Unknown" when no known script holds it. */
function scriptOf(ch: string): string {
  let name = scriptCache.get(ch);
  if (name === undefined) {
    name = "Unknown";
    for (const [script, test] of knownScripts()) {
      if (test.is.test(ch)) {
        name = script;
        break;
      }
    }
    if (scriptCache.size >= 4096) scriptCache.clear();
    scriptCache.set(ch, name);
  }
  return name;
}

/** Whether a script uses a character: its own, or one it shares ("ー" in Katakana and Hiragana). */
function usedIn(ch: string, script: string): boolean {
  const test = knownScripts().get(script);
  return test ? test.uses.test(ch) : scriptOf(ch) === script;
}

/**
 * The letters of a word that stand where a dot would stand, by position: a
 * single letter, or a digit of a script of its own (ARABIC-INDIC DIGIT ZERO),
 * of another script than the letters on both sides of it, which share one
 * script ("bigbank" LISU LETTER TONE MYA TI "example"; Japanese, Chinese and
 * Korean count as one script here); an uncased letter between two cased
 * ones (LATIN LETTER SINOLOGICAL DOT); and any run of letters of a script in
 * NO_HONEST_USE between letters of one other script (two Lisu tone letters,
 * drawn as two dots). Only letters within one stretch of label characters
 * count as sides.
 */
function letterDots(word: readonly string[]): Set<number> {
  const dots = new Set<number>();
  if (ASCII_ONLY.test(word.join(""))) return dots;
  const isLetter = word.map((ch) => LETTER.test(ch));
  const before: number[] = [];
  for (let i = 0, last = -1; i < word.length; i += 1) {
    before[i] = last;
    last = !LABEL_CHAR.test(word[i]) ? -1 : isLetter[i] ? i : last;
  }
  const after: number[] = [];
  for (let i = word.length - 1, next = -1; i >= 0; i -= 1) {
    after[i] = next;
    next = !LABEL_CHAR.test(word[i]) ? -1 : isLetter[i] ? i : next;
  }
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    if (before[i] < 0 || after[i] < 0) continue;
    if (!isLetter[i] && !(NUMBER.test(ch) && scriptOf(ch) !== "Common")) continue;
    const left = word[before[i]];
    const right = word[after[i]];
    if (isLetter[i] && !CASED.test(ch) && CASED.test(left) && CASED.test(right)) {
      dots.add(i);
      continue;
    }
    const script = scriptOf(left);
    if (script === "Common" || script === "Inherited" || !usedIn(right, script) || usedIn(ch, script)) continue;
    if (EAST_ASIAN.includes(script) && EAST_ASIAN.some((s) => usedIn(ch, s))) continue;
    dots.add(i);
  }
  const noHonestUse = (i: number) => isLetter[i] && NO_HONEST_USE.test(word[i]);
  for (let start = 0; start < word.length; start += 1) {
    if (!noHonestUse(start)) continue;
    let end = start;
    while (end + 1 < word.length && noHonestUse(end + 1)) end += 1;
    const left = before[start] >= 0 ? word[before[start]] : undefined;
    const right = after[end] >= 0 ? word[after[end]] : undefined;
    if (left && right && !NO_HONEST_USE.test(left)) {
      const script = scriptOf(left);
      if (script !== "Common" && script !== "Inherited" && usedIn(right, script)) {
        for (let i = start; i <= end; i += 1) dots.add(i);
      }
    }
    start = end;
  }
  return dots;
}

/** How many scripts the letters of some labels are written in; Latin and the East Asian scripts count as one. */
function scriptCount(labels: readonly string[]): number {
  const all = labels.join("");
  if (ASCII_ONLY.test(all)) return 1;
  const groups = new Set<string>();
  for (const ch of all) {
    if (!LETTER.test(ch)) continue;
    const script = scriptOf(ch);
    if (script === "Common" || script === "Inherited") continue;
    groups.add(script === "Latin" || EAST_ASIAN.includes(script) ? "Latin" : script);
  }
  return groups.size;
}

let topLevelDomains: ReadonlySet<string> | undefined;
let topLevelDomainsLoad: Promise<void> | undefined;
const topLevelDomainsListeners = new Set<() => void>();

/**
 * Loads the list of top-level domains (lib/top-level-domains.ts), once. It is
 * only needed where cards are drawn, so it stays out of the first script of
 * every page. Until it is there, every label counts as a top-level domain.
 */
export function loadTopLevelDomains(): Promise<void> {
  topLevelDomainsLoad ??= import("@/lib/top-level-domains").then(
    (mod) => {
      topLevelDomains = mod.TOP_LEVEL_DOMAINS;
      for (const listener of topLevelDomainsListeners) listener();
    },
    (error: unknown) => {
      topLevelDomainsLoad = undefined;
      throw error;
    },
  );
  return topLevelDomainsLoad;
}
// Started with the card code, so the list is there by the time a card is drawn.
loadTopLevelDomains().catch(() => {});

function subscribeTopLevelDomains(onLoad: () => void): () => void {
  topLevelDomainsListeners.add(onLoad);
  return () => {
    topLevelDomainsListeners.delete(onLoad);
  };
}
const topLevelDomainsLoaded = () => topLevelDomains !== undefined;

/** Whether the list of top-level domains has loaded; the component draws again when it does. */
export function useTopLevelDomainsLoaded(): boolean {
  return useSyncExternalStore(subscribeTopLevelDomains, topLevelDomainsLoaded, topLevelDomainsLoaded);
}

/**
 * Whether a label is a top-level domain: delegated or reserved, compared in
 * ASCII form, so "рф" matches "xn--p1ai". True for every label while the list
 * is still loading.
 */
function isTopLevelDomain(label: string): boolean {
  if (!label) return false;
  if (!topLevelDomains) {
    loadTopLevelDomains().catch(() => {});
    return true;
  }
  if (/^[a-z0-9-]+$/.test(label)) return topLevelDomains.has(label);
  const ascii = toAsciiDomain(`x.${label}`);
  return !!ascii && topLevelDomains.has(ascii.slice(ascii.lastIndexOf(".") + 1));
}

/**
 * The part of a label compared with the top-level domains: without leading
 * marks, and up to its first hyphen ("example" of "example-secure") unless it
 * is a punycode label.
 */
function topLevelPart(label: string): string {
  const bare = label.replace(LEADING_MARKS, "").toLowerCase();
  return bare.startsWith("xn--") ? bare : bare.split(HYPHEN)[0];
}

/**
 * Letters that draw like a basic Latin letter upright in common fonts (the
 * app's Segoe UI among them), each with the Latin letter it draws like: Greek,
 * Cyrillic, Armenian, two CJK numerals, and Latin letters outside the basic
 * alphabet. This is what the eye reads, not a transliteration: Greek Η stands
 * for the Latin H here, and Cyrillic Р for P. A capital and its small letter
 * can draw like different Latin letters (Ν is N, ν is v), so the text keeps
 * its case until it is compared.
 */
const LATIN_LOOKALIKES: ReadonlyMap<string, string> = new Map(
  ([
    // Greek capitals Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ, lunate sigma Ϲ, yot Ϳ, digamma Ϝ, san Ϻ
    [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"], [0x039a, "K"],
    [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"], [0x03a5, "Y"], [0x03a7, "X"],
    [0x03f9, "C"], [0x037f, "J"], [0x03dc, "F"], [0x03fa, "M"],
    // Greek small letters ο ν ρ υ ι κ, lunate sigma ϲ, yot ϳ
    [0x03bf, "o"], [0x03bd, "v"], [0x03c1, "p"], [0x03c5, "u"], [0x03b9, "i"], [0x03ba, "k"], [0x03f2, "c"], [0x03f3, "j"],
    // Cyrillic capitals А В Е К М Н О Р С Т У Х, dze Ѕ, dotted І, je Ј, komi de Ԁ, qa Ԛ, we Ԝ, shha Һ, palochka Ӏ, straight u Ү, izhitsa Ѵ
    [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"],
    [0x0420, "P"], [0x0421, "C"], [0x0422, "T"], [0x0423, "Y"], [0x0425, "X"], [0x0405, "S"], [0x0406, "I"],
    [0x0408, "J"], [0x0500, "D"], [0x051a, "Q"], [0x051c, "W"], [0x04ba, "H"], [0x04c0, "I"], [0x04ae, "Y"],
    [0x0474, "V"],
    // Cyrillic small letters а е о р с у х, dze ѕ, dotted і, je ј, komi de ԁ, qa ԛ, we ԝ, shha һ, palochka ӏ, straight u ү, izhitsa ѵ
    [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0443, "y"], [0x0445, "x"],
    [0x0455, "s"], [0x0456, "i"], [0x0458, "j"], [0x0501, "d"], [0x051b, "q"], [0x051d, "w"], [0x04bb, "h"],
    [0x04cf, "l"], [0x04af, "y"], [0x0475, "v"],
    // Armenian capitals Օ Ս, small letters օ ս ո հ ց զ
    [0x0555, "O"], [0x054d, "S"], [0x0585, "o"], [0x057d, "u"], [0x0578, "n"], [0x0570, "h"], [0x0581, "g"], [0x0566, "q"],
    // IDEOGRAPHIC NUMBER ZERO 〇, HANGZHOU NUMERAL ONE 〡 (a vertical stroke)
    [0x3007, "O"], [0x3021, "l"],
    // Latin small capitals ᴄ ᴏ ᴠ ᴡ ᴢ ꜱ, which are the small letters' shapes; script g ɡ (Segoe UI's own g);
    // Latin iota ɩ; dental click ǀ (a vertical stroke)
    [0x1d04, "c"], [0x1d0f, "o"], [0x1d20, "v"], [0x1d21, "w"], [0x1d22, "z"], [0xa731, "s"], [0x0261, "g"],
    [0x0269, "i"], [0x01c0, "l"],
  ] as const).map(([code, latin]) => [String.fromCodePoint(code), latin]),
);
const ASCII_LABEL = /^[A-Za-z0-9-]+$/;
/** The text with the letters of LATIN_LOOKALIKES written as the Latin letters they draw like. */
const asLatinLetters = (text: string) => Array.from(text, (ch) => LATIN_LOOKALIKES.get(ch) ?? ch).join("");
const hasLatinLookalike = (text: string) => Array.from(text).some((ch) => LATIN_LOOKALIKES.has(ch));

/** Two or more labels next to each other in a word, and the single characters between them. */
interface LabelRun {
  labels: string[];
  separators: string[];
  /** How many of the separators are letters (letterDots). */
  letterSeparators: number;
}

/**
 * The runs of labels in a word: split at every dot, a label is a stretch with
 * at least one letter. Two or more dots in a row are one dot ("bigbank..com"),
 * and marks at the start of a label belong to the dot before it. Letter dots
 * are looked for only in the text as written (`withLetterDots`): in the
 * reading with Latin look-alikes, a letter left between two mapped ones is
 * no dot.
 */
function runsOf(word: readonly string[], withLetterDots = true): LabelRun[] {
  const dots = withLetterDots ? letterDots(word) : new Set<number>();
  const segments = [""];
  const separators: string[] = [];
  const separatorIsLetter: boolean[] = [];
  word.forEach((ch, i) => {
    const isSeparator = dots.has(i) || !LABEL_CHAR.test(ch);
    if (separators.length > 0 && segments[segments.length - 1] === "" && (isSeparator || MARK.test(ch))) {
      separators[separators.length - 1] += ch;
      if (dots.has(i)) separatorIsLetter[separatorIsLetter.length - 1] = true;
    } else if (isSeparator) {
      separators.push(ch);
      separatorIsLetter.push(dots.has(i));
      segments.push("");
    } else {
      segments[segments.length - 1] += ch;
    }
  });
  const runs: LabelRun[] = [];
  let start = 0;
  for (let end = 0; end <= segments.length; end += 1) {
    if (end < segments.length && LETTER.test(segments[end])) continue;
    if (end - start >= 2) {
      runs.push({
        labels: segments.slice(start, end),
        separators: separators.slice(start, end - 1),
        letterSeparators: separatorIsLetter.slice(start, end - 1).filter(Boolean).length,
      });
    }
    start = end + 1;
  }
  return runs;
}

/**
 * Whether labels name a domain outside the sender's by their end: the longest
 * part of them that ends in a top-level domain ("pay.shop.example",
 * "bigbank.example-secure"). A label also counts as the top-level domain it
 * draws like when its letters, read through LATIN_LOOKALIKES on their own,
 * spell one in basic Latin ("Сбербанк.СОМ", "bigbank.〇rg"), whatever the
 * labels before it are written in.
 */
function endsInOtherDomain(labels: readonly string[], senderDomain: string): boolean {
  for (let end = labels.length; end >= 2; end -= 1) {
    const label = labels[end - 1];
    const latin = asLatinLetters(label);
    for (const candidate of latin === label ? [label] : [label, latin]) {
      const top = topLevelPart(candidate);
      if (candidate === latin && candidate !== label && !ASCII_LABEL.test(top)) continue;
      if (isTopLevelDomain(top)) return isOutsideSender([...labels.slice(0, end - 1), top].join("."), senderDomain);
    }
  }
  return false;
}

/**
 * Whether a run of labels names a domain outside the sender's. It reads as a
 * look-alike of a domain, whatever its last label, when it holds a letter of
 * a script in NO_HONEST_USE, when its letters are written in two scripts
 * (Latin and the East Asian scripts count as one), or when a letter stands
 * for one of two or more dots ("bigbank.cօm" with an Armenian օ). Two scripts
 * also catch what LATIN_LOOKALIKES cannot: an ending in Armenian letters that
 * draw like Latin ones ("bigbank.օրգ"), and a Cyrillic or Greek one with a
 * letter outside the table ("bigbank.сом", Cyrillic м). Otherwise the run
 * names the domain it ends in (endsInOtherDomain).
 */
function runNamesOtherDomain(run: LabelRun, senderDomain: string): boolean {
  if (
    NO_HONEST_USE.test(run.labels.join("") + run.separators.join(""))
    || scriptCount(run.labels) > 1
    || (run.letterSeparators > 0 && run.labels.length > 2)
  ) {
    return isOutsideSender(run.labels.join("."), senderDomain);
  }
  return endsInOtherDomain(run.labels, senderDomain);
}

/**
 * Whether a word (text between spaces and word joiners) names a domain
 * outside the sender's. In the reading with Latin look-alikes (asLatin), a run
 * counts only by the domain it ends in.
 */
function wordNamesOtherDomain(word: readonly string[], senderDomain: string, asLatin: boolean): boolean {
  return runsOf(word, !asLatin).some((run) => (asLatin ? endsInOtherDomain(run.labels, senderDomain) : runNamesOtherDomain(run, senderDomain)));
}

/** Whether a text (after step 1) names a domain outside the sender's, word by word. */
function wordsNameOtherDomain(text: string, senderDomain: string, asLatin: boolean): boolean {
  let word: string[] = [];
  for (const ch of text) {
    if (ch === " " || WORD_JOINERS.has(ch)) {
      if (word.length > 0 && wordNamesOtherDomain(word, senderDomain, asLatin)) return true;
      word = [];
    } else {
      word.push(ch);
    }
  }
  return word.length > 0 && wordNamesOtherDomain(word, senderDomain, asLatin);
}

/** A text as it could be drawn: a space or joiner with marks on it as a dot, the other spaces as nothing. */
const asDrawn = (text: string) => text.replace(SPACE_WITH_MARKS, ".").replace(OTHER_SPACES, "");

/**
 * Whether a text from the mail may not be shown on the card of a message
 * from `senderDomain`: it holds a character outside the expected set, or a
 * run of labels in it names a domain outside the sender's. The sender's own
 * domain and the ones below it may be named.
 *
 * The text is read without SOFT_INVISIBLES, and, after step 1, as it could be
 * drawn (asDrawn), before NFKC and again after it.
 *
 * A text with letters that draw like Latin ones is read a second time with
 * those letters as the Latin ones (LATIN_LOOKALIKES): a run then names the
 * domain it ends in ("ΑΜΑΖΟΝ.ϹΟΜ"). The letters are replaced before NFKC,
 * which turns the lunate sigma Ϲ, drawn like C, into Σ, and again after it,
 * for forms it folds into one of them. A run whose end, read through the
 * table, spells no top-level domain is judged as written ("г.Новосибирск",
 * "κ.Παπαδόπουλος").
 */
export function namesOtherDomain(text: string, senderDomain: string): boolean {
  const read = text.replace(SOFT_INVISIBLES, "");
  const normal = read.normalize("NFKC");
  if (!CARD_TEXT.test(normal) || IGNORABLE.test(normal)) return true;
  const drawn = asDrawn(asDrawn(read).normalize("NFKC"));
  if (wordsNameOtherDomain(drawn, senderDomain, false)) return true;
  if (!hasLatinLookalike(read) && !hasLatinLookalike(drawn)) return false;
  return wordsNameOtherDomain(asDrawn(asLatinLetters(asLatinLetters(asDrawn(read)).normalize("NFKC"))), senderDomain, true);
}

/**
 * Text from the markup as the card may show it: undefined when it names a
 * domain outside the sender's (namesOtherDomain), so a sender cannot present
 * a card as coming from another domain.
 */
export function brandText(text: string | undefined, senderDomain: string): string | undefined {
  const value = text?.trim();
  if (!value || namesOtherDomain(value, senderDomain)) return undefined;
  return value;
}

/** Strings in a card that are values of the app's own, never the sender's text as written. */
const MACHINE_KEYS = new Set(["key", "kind", "source", "status", "modified", "date", "time", "utc", "zone", "country", "currency", "amount"]);

function isCardLink(value: object): value is Link {
  const link = value as Partial<Link>;
  return typeof link.url === "string" && typeof link.host === "string";
}

function textForDisplay(value: unknown, senderDomain: string, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && MACHINE_KEYS.has(key)) return value;
    // The check read it without the soft hyphen; the card shows it without one too.
    return namesOtherDomain(value, senderDomain) ? "" : value.replace(SOFT_HYPHEN, "");
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== "string" || !namesOtherDomain(item, senderDomain))
      .map((item) => textForDisplay(item, senderDomain));
  }
  if (value && typeof value === "object") {
    // A link's host is where the button leads, shown as such and marked when it is outside.
    if (isCardLink(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, textForDisplay(v, senderDomain, k)]));
  }
  return value;
}

/** Whether a text the mail gave was left out. */
const lost = (before: string | undefined, after: string | undefined) => !!before?.trim() && !after?.trim();
/** Whether a place still says where: a name, a town or a code. */
const placeNamed = (place: Place | undefined) => !!(place?.name?.trim() || place?.address?.locality?.trim() || place?.code?.trim());

/**
 * A leg or item that lost its text is left out as a whole, so a card never
 * shows "Wien Hbf → ?", an empty entry in a list or a count that includes
 * it: a leg whose departure or arrival place no longer says where, a seat
 * whose number or passenger was left out, an item whose name was. A trip
 * with no leg left, and an order or parcel with nothing left that says which
 * one it is (merchant, order number, carrier, tracking number, item), is not
 * drawn at all. Other cards keep their kind as the title when their name was
 * left out (brandText).
 */
function withoutLostParts(card: StructuredCard, shown: StructuredCard): StructuredCard | null {
  if (isTransport(card) && isTransport(shown)) {
    const legs = shown.legs.flatMap((leg, i) => {
      const before = card.legs[i];
      if (placeNamed(before.departure.place) && !placeNamed(leg.departure.place)) return [];
      if (before.arrival && placeNamed(before.arrival.place) && !placeNamed(leg.arrival?.place)) return [];
      const seats = leg.seats.filter((seat, j) => !lost(before.seats[j]?.seat, seat.seat) && !lost(before.seats[j]?.passenger, seat.passenger));
      return [{ ...leg, seats }];
    });
    return legs.length > 0 ? { ...shown, legs } : null;
  }
  if (card.kind === "shipment" && shown.kind === "shipment") {
    const named = (items: Item[], before: Item[]) => items.filter((item, i) => !lost(before[i]?.name, item.name));
    const result: Shipment = {
      ...shown,
      items: named(shown.items, card.items),
      parcels: shown.parcels.map((parcel, i) => ({ ...parcel, items: named(parcel.items, card.parcels[i]?.items ?? []) })),
    };
    const saysWhich = (s: Shipment) => !!(s.merchant?.trim() || s.orderNumber?.trim() || s.items.length > 0
      || s.parcels.some((p) => p.carrier?.trim() || p.trackingNumber?.trim() || p.items.length > 0));
    return saysWhich(card) && !saysWhich(result) ? null : result;
  }
  return shown;
}

/**
 * The card as it is shown, or null when it is not drawn: every text the
 * sender wrote into it (names, places, passengers, items, numbers) goes
 * through namesOtherDomain, and a text that names a domain outside the
 * sender's is left out (an empty string, or dropped from a list), with the
 * leg, seat or item it belonged to (withoutLostParts). Links stay as they are.
 */
export function cardForDisplay<T extends StructuredCard>(card: T, senderDomain: string): T | null {
  return withoutLostParts(card, textForDisplay(card, senderDomain) as T) as T | null;
}

/**
 * A link from the mail with its host beside the label ("Track · dhl.de").
 * A host outside the sender's domain carries a mark. Opens like a link in the
 * message body: plugins may stop or redirect it, then a new tab without
 * opener or referrer.
 */
export function CardLink({ link, label, icon: Icon = ExternalLink, emailId, senderDomain }: { link?: Link; label: string; icon?: IconType; emailId?: string; senderDomain: string }) {
  const tTrust = useTranslations("sender_trust");
  if (!link || !isWebLink(link)) return null;
  const outside = isOutsideSender(link.host, senderDomain);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={outside ? tTrust("outside_link_title", { host: link.host, domain: senderDomain }) : undefined}
      className={cn(ACTION_CLASS, "flex-wrap gap-y-0")}
      data-testid="structured-mail-link"
      data-outside={outside || undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openExternalLink({ href: link.url, target: "_blank", emailId, text: label });
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        void openExternalLink({ href: link.url, target: "_blank", emailId, text: label });
      }}
    >
      <Icon aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
      {/* The host is how a reader judges the link: wrapped, never cut off. */}
      <span className="max-w-full [overflow-wrap:anywhere] text-muted-foreground/80">· <bdi dir="ltr">{link.host}</bdi></span>
      {outside && (
        <span className={cn(PILL_CLASS, "bg-warning/15 text-warning")} data-testid="structured-mail-outside-link">
          {tTrust("outside_link")}
        </span>
      )}
    </a>
  );
}

interface CardShellProps {
  /** Accessible name of the region ("Flight booking"). */
  name: string;
  icon: IconType;
  /** Destructive tone and a struck-through title. */
  cancelled?: boolean;
  /** The kind, and the provider in a <bdi> (eyebrowText). */
  eyebrow: ReactNode;
  /** A title from the mail is drawn in a <bdi>; a route brings its own (RouteTitle). */
  title: ReactNode;
  /** What screen readers hear instead of a title drawn from parts (a route with arrow icons). */
  titleLabel?: string;
  pills?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  kind: string;
  /** The verified sender domain (cardSenderDomain), named next to the brand the markup claims. */
  senderDomain: string;
}

/**
 * The banner layout every card shares (CalendarInvitationBanner's look).
 * Every text from the mail on a card is drawn in its own <bdi>, so right-to-
 * left text in it cannot change the order of the text around it: the
 * verified sender line, or another field.
 */
export function CardShell({ name, icon: Icon, cancelled = false, eyebrow, title, titleLabel, pills, children, actions, kind, senderDomain }: CardShellProps) {
  const tTrust = useTranslations("sender_trust");
  const shownTitle = typeof title === "string" ? <bdi>{title}</bdi> : title;
  return (
    <section aria-label={name} className="flex items-start gap-3 min-w-0" data-testid="structured-mail-card" data-kind={kind}>
      <div
        aria-hidden="true"
        className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
          cancelled ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
        )}
      >
        <Icon aria-hidden="true" className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="min-w-0">
          <div className="text-[0.6875rem] font-semibold text-muted-foreground break-words">
            {eyebrow}
            {senderDomain && (
              <>
                {" · "}
                <span
                  className="font-normal [overflow-wrap:anywhere]"
                  title={tTrust("card_sender_title", { domain: senderDomain })}
                  data-testid="structured-mail-sender-domain"
                >
                  {tTrust("card_sender", { domain: senderDomain })}
                </span>
              </>
            )}
          </div>
          <h3 className={cn("text-sm font-semibold leading-snug break-words", cancelled ? "line-through text-muted-foreground" : "text-foreground")}>
            {titleLabel ? (
              <>
                <span className="sr-only">{titleLabel}</span>
                <span aria-hidden="true" data-testid="structured-mail-title-visual">{shownTitle}</span>
              </>
            ) : shownTitle}
          </h3>
        </div>
        {pills && <div className="flex flex-wrap items-center gap-1.5">{pills}</div>}
        {children && <div className="flex flex-col gap-1 text-sm text-muted-foreground">{children}</div>}
        {actions && <div className="flex flex-wrap items-center gap-1.5 pt-0.5" data-testid="structured-mail-actions">{actions}</div>}
      </div>
    </section>
  );
}

/**
 * "Flight · Lufthansa", the provider in a <bdi>; the kind alone when the
 * provider is missing, already the title, or names a domain outside the
 * sender's (brandText).
 */
export function eyebrowText(kind: string, provider: string | undefined, title: string, senderDomain: string): ReactNode {
  const p = brandText(provider, senderDomain);
  return p && p.toLowerCase() !== title.trim().toLowerCase() ? <>{kind} · <bdi>{p}</bdi></> : kind;
}
