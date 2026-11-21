/**
 * @ mentions in a note: finding what the user is typing after @, putting the
 * picked person in as "@Name ", and, when the note is saved, the principal
 * ids of the people still mentioned in the text, checked against the team's
 * people. Only ids the team knows are stored.
 */

export interface MentionCandidate {
  id: string;
  name: string;
  email: string;
}

export interface PickedMention {
  id: string;
  /** What was put into the text after the @. */
  label: string;
}

const MAX_QUERY = 40;

/**
 * The mention being typed at the caret: the @ (at the start or after a
 * space or line break) and what follows it up to the caret, or null.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n\r]/.test(query) || /\s{2,}/.test(query)) return null;
  return { start: at, query };
}

/** The people that fit what was typed, best first: name starts with it, then contains it, then the address. */
export function mentionCandidates(people: readonly MentionCandidate[], query: string, selfId: string | null, limit = 8): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const scored = people
    .filter((p) => p.id && p.id !== selfId && (p.name || p.email))
    .map((p) => {
      const name = (p.name || p.email).toLowerCase();
      const words = name.split(/\s+/);
      const score = !q ? 1
        : name.startsWith(q) || words.some((w) => w.startsWith(q)) ? 0
          : name.includes(q) ? 1
            : p.email.toLowerCase().includes(q) ? 2
              : -1;
      return { p, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || (a.p.name || a.p.email).localeCompare(b.p.name || b.p.email));
  return scored.slice(0, limit).map((x) => x.p);
}

/** Puts "@Name " in place of the @ and the typed query; returns the new text and caret. */
export function insertMention(text: string, at: { start: number; query: string }, person: MentionCandidate): { text: string; caret: number; picked: PickedMention } {
  const label = person.name || person.email;
  const insert = `@${label} `;
  const end = at.start + 1 + at.query.length;
  const next = text.slice(0, at.start) + insert + text.slice(end).replace(/^ /, '');
  return { text: next, caret: at.start + insert.length, picked: { id: person.id.toLowerCase(), label } };
}

/**
 * The ids to store with a note: the picked people whose "@Name" is still in
 * the text, and who are people of the team. Unknown ids are dropped.
 */
export function mentionsIn(text: string, picked: readonly PickedMention[], teamIds: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const p of picked) {
    if (!text.includes(`@${p.label}`)) continue;
    const id = p.id.toLowerCase();
    if (teamIds.has(id)) ids.add(id);
  }
  return [...ids];
}
