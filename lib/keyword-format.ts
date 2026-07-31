/**
 * Naming a tag on screen.
 *
 * A nested tag is written out level by level - `Work/Clients/Acme` - and a flat
 * one is simply its own name, so nothing here asks the caller which kind it
 * has. `keywordRenderings` additionally offers progressively shorter forms for
 * a name with nowhere to fit, which `useShortenedText` measures against the
 * room actually available.
 */
import type { KeywordDefinition } from "@/stores/settings-store";
import { KEYWORD_SEPARATOR, keywordLevels } from "./keyword-nesting";

/** Stands in for one level left out of a name. */
export const KEYWORD_SHORTENED_LEVEL = "..";

/** Stands in for a run of more than one level left out of a name. */
export const KEYWORD_SHORTENED_RUN = "...";

/**
 * The display name of a tag, one entry per level, outermost first. A tag with
 * one level yields a single entry, so callers need not care either way.
 *
 * `nested` is the user's setting. With nesting off a slash carries no meaning,
 * so the id is one opaque token and the tag is named by its own label - nobody
 * who left the setting alone should find their tags rewritten because an id
 * happens to contain a slash, which can outlast turning nesting off, or arrive
 * through settings sync or another client.
 *
 * With nesting on, each level resolves to that tag's display name, falling back
 * to the raw level of the id when it has no definition - the settings list only
 * describes the tags this client knows about. Levels stay separate entries
 * because a display name may itself contain a slash, which is part of that one
 * name rather than a level of its own.
 */
export function formatKeywordLabels(
  id: string,
  keywords: KeywordDefinition[],
  nested: boolean,
): string[] {
  const label = (levelId: string) => keywords.find((keyword) => keyword.id === levelId)?.label;
  if (!nested) return [label(id) ?? id];

  const levels = keywordLevels(id);
  return levels.map((level, index) =>
    label(levels.slice(0, index + 1).join(KEYWORD_SEPARATOR)) ?? level,
  );
}

/**
 * The display name of a tag: `Work/Clients/Acme` for a nested one, its own name
 * otherwise. The general way to name a tag on screen.
 */
export function formatKeyword(
  id: string,
  keywords: KeywordDefinition[],
  nested: boolean,
): string {
  return formatKeywordLabels(id, keywords, nested).join(KEYWORD_SEPARATOR);
}

/**
 * Every way a name can be written, longest first: in full, then with an ever
 * longer run of intermediate levels replaced by `..`, collapsing to a single
 * `...` as soon as that run covers more than one level.
 *
 * The outermost and innermost levels always survive - between them they say
 * which branch a tag belongs to and which tag it is, which is exactly what a
 * trailing ellipsis destroys. A rendering that would not actually come out
 * shorter than the one before it (levels named `it`, say) is dropped, so
 * walking the list never makes the text grow.
 */
export function keywordRenderings(levels: string[]): string[] {
  const renderings = [levels.join(KEYWORD_SEPARATOR)];
  for (let shortened = 1; shortened <= levels.length - 2; shortened++) {
    const marker = shortened === 1 ? KEYWORD_SHORTENED_LEVEL : KEYWORD_SHORTENED_RUN;
    const rendering = [levels[0], marker, ...levels.slice(shortened + 1)]
      .join(KEYWORD_SEPARATOR);
    if (rendering.length < renderings[renderings.length - 1].length) {
      renderings.push(rendering);
    }
  }
  return renderings;
}
