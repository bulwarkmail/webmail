"use client";

import { useLocale, useTranslations } from "next-intl";
import { Languages } from "@/components/icons";
import { languages, useLanguageOptions } from "@/components/ui/language-switcher";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useLocaleStore } from "@/stores/locale-store";
import { noteSignedOutChoice } from "@/lib/signed-out-choices";

/**
 * The language picker in the sign-in page's corner, for someone who can't
 * read the language the browser picked. The same list as Settings >
 * Language, and the choice is kept through the sign-in
 * (lib/signed-out-choices.ts).
 */
export function LoginLanguagePicker() {
  const t = useTranslations();
  const setLocale = useLocaleStore((state) => state.setLocale);
  const choice = useLocaleStore((state) => state.locale) || "auto";
  const options = useLanguageOptions();
  // "Auto" says nothing about the page: the button names the language it is in.
  const active = useLocale();
  const shown = languages.find((lang) => lang.value === active)?.label ?? active;

  return (
    <SearchableSelect
      value={choice}
      options={options}
      onSelect={(value) => {
        setLocale(value);
        noteSignedOutChoice("locale");
      }}
      ariaLabel={t("login_a11y.language_button", { language: shown })}
      searchLabel={t("common.search")}
      noMatchLabel={t("sharing.no_match")}
      buttonClassName="h-9 w-auto px-2.5 sm:px-3 bg-background border-border text-muted-foreground hover:text-foreground hover:bg-muted hover:border-border"
      renderValue={() => (
        <>
          <Languages className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline" dir="auto">{shown}</span>
        </>
      )}
    />
  );
}
