"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { collectionLabel } from "@/lib/default-collection-name";

interface NamedCollection {
  name: string;
  isShared?: boolean;
}

/**
 * Names for calendars and address books as Settings shows them: Stalwart's own
 * "Stalwart Calendar (<address>)" becomes "Calendar", in the user's language.
 * Use it wherever a calendar or address book name reaches the screen.
 */
export function useCollectionNames(): {
  calendar: (calendar: NamedCollection) => string;
  addressBook: (book: NamedCollection) => string;
} {
  const t = useTranslations("uxs_wording");
  return useMemo(() => {
    const calendarName = t("default_calendar");
    const bookName = t("default_address_book");
    return {
      calendar: (calendar: NamedCollection) => collectionLabel(calendar, "calendar", calendarName),
      addressBook: (book: NamedCollection) => collectionLabel(book, "addressBook", bookName),
    };
  }, [t]);
}
