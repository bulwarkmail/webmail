"use client";

import { useCallback } from "react";
import { useCollectionNames } from "@/hooks/use-collection-names";
import type { GlobalSearchHit } from "@/lib/global-search/types";

/**
 * A hit's line under its title: the account, then where it is, with Stalwart's default
 * calendar and address book called "Calendar" and "Contacts" as everywhere else (p2-3).
 */
export function useHitSubtitle(): (hit: GlobalSearchHit) => string {
  const names = useCollectionNames();
  return useCallback((hit: GlobalSearchHit) => {
    const where = hit.collection
      ? [hit.collection.kind === "calendar" ? names.calendar(hit.collection) : names.addressBook(hit.collection), hit.collection.rest].filter(Boolean).join(" · ")
      : hit.subtitle;
    return [hit.accountLabel, where].filter(Boolean).join(" · ");
  }, [names]);
}
