"use client";

import { useMemo } from "react";
import {
  useSettingsStore,
  KEYWORD_PALETTE,
  FALLBACK_KEYWORD_COLOR,
  type KeywordColor,
} from "@/stores/settings-store";
import { formatKeyword, formatKeywordLabels, keywordRenderings } from "@/lib/keyword-format";

/**
 * Names and colours tags for the screen, bound to the user's tag settings.
 *
 * Resolving the definitions and the nesting setting here rather than at every
 * call site means no caller can forget the setting and render a nested name to
 * someone who never asked for nesting. Subscribing to them also keeps tags in
 * step the moment either changes: reading the store inside the formatter would
 * leave every list stale until something else happened to re-render it.
 */
export function useKeywordFormat() {
  const keywords = useSettingsStore((state) => state.emailKeywords);
  const nested = useSettingsStore((state) => state.nestedTags);

  return useMemo(
    () => ({
      /** The tag's display name. */
      tagName: (id: string) => formatKeyword(id, keywords, nested),

      /** Its progressively shorter forms, longest first, for `useShortenedText`. */
      tagNameCandidates: (id: string) => keywordRenderings(formatKeywordLabels(id, keywords, nested)),

      /**
       * The tag's colour. Falls back to grey for a keyword this client has no
       * definition for - one created on another device, or whose tag was
       * deleted - so such a tag still shows rather than silently vanishing.
       */
      tagColor: (id: string): KeywordColor => {
        const color = keywords.find((keyword) => keyword.id === id)?.color;
        return (color ? KEYWORD_PALETTE[color] : undefined) ?? KEYWORD_PALETTE[FALLBACK_KEYWORD_COLOR];
      },

      /**
       * Tag ids in the order the user arranged them in settings.
       *
       * The keywords on a message arrive as an unordered JMAP map, so without
       * this the same two tags can swap places between rows. A tag with no
       * local definition has no place in that order, so it sorts last, by name.
       */
      sortTagIds: (ids: string[]): string[] => {
        const rank = (id: string) => {
          const index = keywords.findIndex((keyword) => keyword.id === id);
          return index === -1 ? keywords.length : index;
        };
        return [...ids].sort(
          (a, b) =>
            rank(a) - rank(b) ||
            formatKeyword(a, keywords, nested).localeCompare(formatKeyword(b, keywords, nested)),
        );
      },
    }),
    [keywords, nested],
  );
}
