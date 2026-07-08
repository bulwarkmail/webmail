// Reply / forward subject prefix handling.
//
// Real-world email subjects accumulate prefixes across clients and languages:
// "Re: AW: WG: Fwd: Re: foo". The deduplication regex needs to know ALL
// commonly-used reply/forward markers - not just the current locale's, since
// inbound messages may come from any locale. Failing to strip a foreign-locale
// prefix means the user's locale prefix gets *added on top* and the subject
// chain keeps growing.
//
// Sources: de-facto conventions in Outlook / Thunderbird / Apple Mail per
// language. Includes a handful of legacy short-forms (R:, Fw:) that some
// mobile clients still emit.

const REPLY_TOKENS = [
  "Re",      // English, Italian, French (also generic ISO)
  "RE",      // Outlook variant
  "AW",      // German (Antwort)
  "Antw",    // German verbose
  "Sv",      // Danish / Swedish / Norwegian (Svar)
  "Yn",      // Turkish (Yanit)
  "Yanit",   // Turkish verbose
  "Odp",     // Polish (Odpowiedz)
  "Ответ",   // Russian
  "Resp",    // Spanish/Portuguese variant
  "Vá",      // Hungarian
  "回复",    // Chinese
  "回覆",    // Chinese traditional
  "답장",    // Korean
  // NB: deliberately no bare "R" token — a single letter would strip the first
  // word of legitimate subjects like "R: budget 2024". The full "Re" covers
  // the common Italian/English case anyway.
];

const FORWARD_TOKENS = [
  "Fwd",     // English standard
  "Fw",      // English short / Polish / German short
  "WG",      // German (Weitergeleitet)
  "Tr",      // French (Transfert)
  "Vs",      // Danish (Videresend)
  "Enc",     // Portuguese (Encaminhar)
  "ENC",     // Portuguese caps
  "Rv",      // Spanish (Reenviar)
  "RV",      // Spanish caps
  "Rvf",     // Spanish variant
  "Inol",    // Italian (Inoltro)
  // NB: deliberately no bare "I" token — see the REPLY_TOKENS note above.
  "PD",      // Polish (Przekazane Dalej)
  "PR",      // Czech (Preposlat)
  "İlt",     // Turkish (Ilet)
  "Ilt",     // Turkish ASCII
  "Пересл",  // Russian (Peresylka)
  "Пер",     // Russian short
  "转发",    // Chinese
  "轉寄",    // Chinese traditional
  "전달",    // Korean
];

// Match a single prefix token + optional [N] counter (Outlook) or *N (Eudora)
// + colon + whitespace. Case-insensitive. The non-capturing groups keep the
// regex composable for stripping multiple prefixes in a row.
function buildPrefixRegex(tokens: string[]): RegExp {
  // Escape regex specials in tokens (none currently, but be defensive)
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Sort by length DESC so longer tokens (e.g. "Пересл") win over their
  // shorter prefixes (e.g. "Пер") during alternation matching.
  escaped.sort((a, b) => b.length - a.length);
  // Accept both the ASCII colon and the full-width colon "：" (U+FF1A) that CJK
  // mail clients emit after a localized prefix (e.g. "回复：foo").
  return new RegExp(
    `^\\s*(?:${escaped.join("|")})(?:\\[\\d+\\]|\\*\\d*)?\\s*[:\\uFF1A]\\s*`,
    "i",
  );
}

const ANY_PREFIX_RE = buildPrefixRegex([...REPLY_TOKENS, ...FORWARD_TOKENS]);

/**
 * Strip any leading sequence of reply/forward prefixes (across languages) from
 * a subject line. Idempotent and safe for empty input.
 *
 * Examples:
 *   stripSubjectPrefixes("Re: AW: WG: foo")        === "foo"
 *   stripSubjectPrefixes("Re[2]: foo")             === "foo"
 *   stripSubjectPrefixes("RE: Re: foo")            === "foo"
 *   stripSubjectPrefixes("foo")                    === "foo"
 *   stripSubjectPrefixes("")                       === ""
 */
export function stripSubjectPrefixes(subject: string | undefined | null): string {
  if (!subject) return "";
  let s = subject;
  // Bounded loop: in practice you never see more than ~10 prefixes; the bound
  // protects against pathological input. Each iteration must consume input.
  for (let i = 0; i < 20; i++) {
    const next = s.replace(ANY_PREFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Build a reply subject with the given locale-aware prefix. Strips any
 * pre-existing prefixes (in any language) first so chains don't accumulate.
 *
 *   buildReplySubject("AW: WG: foo", "Re:")   === "Re: foo"
 *   buildReplySubject("foo", "AW:")           === "AW: foo"
 *   buildReplySubject("", "AW:")              === "AW:"
 */
export function buildReplySubject(subject: string | undefined | null, prefix: string): string {
  const stripped = stripSubjectPrefixes(subject);
  return stripped ? `${prefix} ${stripped}` : prefix;
}

/**
 * Build a forward subject. Same logic as buildReplySubject but conceptually
 * separate for clarity at the call site.
 */
export function buildForwardSubject(subject: string | undefined | null, prefix: string): string {
  const stripped = stripSubjectPrefixes(subject);
  return stripped ? `${prefix} ${stripped}` : prefix;
}
