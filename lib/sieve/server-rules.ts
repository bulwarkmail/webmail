/**
 * Server rules: a region of the filters script that the mail host's own
 * tooling manages (an admin panel's block list, a forward set up outside
 * the webmail), typically an `include` of a script of its own.
 *
 * Only one Sieve script can be active, and Bulwark's is the one the user
 * edits. A host that needs its rules to run as well cannot activate a
 * script of its own without switching the user's filters off, so it puts
 * them in this region instead:
 *
 *   # --- Server rules (managed outside Bulwark) ---
 *   include :personal :optional "host-rules";
 *   # --- End of server rules ---
 *
 * Bulwark keeps the region verbatim, first after `require` (ahead of the
 * vacation include and the user's rules, so a block list runs before an
 * auto-reply), never shows it as a rule and keeps the script active while
 * the region is there. The region carries no `require` of its own: the
 * extensions it uses are listed in the script's top-level one, where
 * Bulwark keeps them.
 */
export const SERVER_RULES_BEGIN = '# --- Server rules (managed outside Bulwark) ---';
export const SERVER_RULES_END = '# --- End of server rules ---';

/**
 * Take the first server rules region out of `content`. `serverRules` is
 * what sits between the markers, trimmed ('' when there is none or the end
 * marker is missing, in which case `content` is returned as it is).
 */
export function extractServerRules(content: string): { cleaned: string; serverRules: string } {
  const begin = findMarkerLine(content, SERVER_RULES_BEGIN, 0);
  if (begin === -1) return { cleaned: content, serverRules: '' };
  const interiorStart = lineEnd(content, begin);
  const end = findMarkerLine(content, SERVER_RULES_END, interiorStart);
  if (end === -1) return { cleaned: content, serverRules: '' };
  const after = lineEnd(content, end);
  return {
    cleaned: content.slice(0, begin) + content.slice(after),
    serverRules: content.slice(interiorStart, end).trim(),
  };
}

/** The region as the generator writes it. */
export function renderServerRules(serverRules: string): string[] {
  return [SERVER_RULES_BEGIN, serverRules.trim(), SERVER_RULES_END];
}

// The index of a line that is exactly `marker` (surrounding blanks allowed),
// at or after `from`, or -1.
function findMarkerLine(content: string, marker: string, from: number): number {
  let i = from;
  while (true) {
    const idx = content.indexOf(marker, i);
    if (idx === -1) return -1;
    const start = content.lastIndexOf('\n', idx - 1) + 1;
    const stop = lineEnd(content, idx);
    if (content.slice(start, stop).trim() === marker) return start;
    i = idx + marker.length;
  }
}

// The index just past the line holding `at` (past its newline).
function lineEnd(content: string, at: number): number {
  const nl = content.indexOf('\n', at);
  return nl === -1 ? content.length : nl + 1;
}
