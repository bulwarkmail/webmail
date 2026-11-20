/**
 * IMAP flags to JMAP keywords (RFC 8621 §4.1.1): the system flags to their
 * `$` names, other keywords as they are when JMAP takes them, and
 * `\Deleted` and `\Recent` dropped (the server sets those, if anything).
 */

const SYSTEM_FLAGS: Record<string, string | null> = {
  '\\seen': '$seen',
  '\\flagged': '$flagged',
  '\\answered': '$answered',
  '\\draft': '$draft',
  '\\deleted': null,
  '\\recent': null,
};

/** RFC 8621: 1 to 255 printable ASCII characters, none of ( ) { ] % * " \ and no space. */
const JMAP_KEYWORD = /^[\x21-\x7e]{1,255}$/;
const FORBIDDEN = /[(){\]%*"\\]/;

export function isValidJmapKeyword(keyword: string): boolean {
  return JMAP_KEYWORD.test(keyword) && !FORBIDDEN.test(keyword);
}

export function keywordsFromFlags(flags: Iterable<string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const flag of flags) {
    const lower = flag.toLowerCase();
    if (lower in SYSTEM_FLAGS) {
      const mapped = SYSTEM_FLAGS[lower];
      if (mapped) out[mapped] = true;
      continue;
    }
    // Other `\` flags are system flags JMAP has no name for.
    if (flag.startsWith('\\')) continue;
    // JMAP keywords are case-insensitive and sent lowercase ($Forwarded → $forwarded).
    if (isValidJmapKeyword(flag)) out[lower] = true;
  }
  return out;
}
